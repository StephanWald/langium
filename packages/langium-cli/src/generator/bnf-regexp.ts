/******************************************************************************
 * Copyright 2026 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { Alternative, Assertion, Atom, Disjunction, Quantifier, Set as RegExpSet, Term } from '@chevrotain/regexp-to-ast';
import { RegExpParser } from '@chevrotain/regexp-to-ast';

/**
 * A piece of BNF text together with the information whether it needs to be parenthesized
 * before a cardinality is appended or before it is embedded into a sequence.
 */
export interface BnfFragment {
    text: string;
    kind: 'atom' | 'sequence' | 'alternatives';
}

export interface RegexToBnfOptions {
    /** Treat the pattern as case insensitive, in addition to the `i` flag of the regular expression. */
    caseInsensitive?: boolean;
    /** Receives a message for each construct that cannot be expressed in BNF. */
    onWarning?: (message: string) => void;
}

type CodeRange = [from: number, to: number];

const MAX_CODE_POINT = 0x10FFFF;
const EMPTY: BnfFragment = { text: '', kind: 'sequence' };

/**
 * Translates a JavaScript regular expression into BNF syntax:
 * Literal characters are quoted, shorthand character classes are expanded, disjunctions are parenthesized.
 * Lazy quantifiers are emitted as greedy ones, which doesn't make a difference for a context-free grammar.
 * Anchors and lookaround assertions cannot be expressed and are dropped, so the result accepts a superset of the input of the regular expression.
 *
 * @param regex A regular expression or the text of a regular expression literal, i.e. `/source/flags`
 */
export function regexToBnf(regex: RegExp | string, options: RegexToBnfOptions = {}): BnfFragment {
    const literal = regex.toString();
    const lastSlash = literal.lastIndexOf('/');
    const flags = literal.substring(lastSlash + 1);
    // the parser only knows the flags `gimuy`, all others are handled here
    const source = literal.substring(0, lastSlash + 1);
    const warn = options.onWarning ?? (() => { });
    if (flags.includes('u') || flags.includes('v')) {
        if (/\\[pP]\{|\\u\{/.test(source)) {
            warn(`Unicode property escapes and code point escapes are not supported: ${literal}`);
        }
    }
    const translator = new RegexTranslator(source, {
        ignoreCase: flags.includes('i') || !!options.caseInsensitive,
        dotAll: flags.includes('s'),
        warn
    });
    return translator.translate();
}

/**
 * Converts a text into BNF string literals. With `caseInsensitive` each letter is turned into a character class, e.g. `[aA]`.
 */
export function literalToBnf(text: string, caseInsensitive = false): BnfFragment {
    const parts: string[] = [];
    let quoted = '';
    const flush = () => {
        if (quoted.length > 0) {
            parts.push(`"${quoted}"`);
            quoted = '';
        }
    };
    for (const char of text) {
        const codePoint = char.codePointAt(0)!;
        const variants = caseInsensitive ? caseVariants(codePoint) : [codePoint];
        if (variants.length > 1) {
            flush();
            parts.push(`[${variants.map(escapeInClass).join('')}]`);
        } else {
            quoted += escapeInString(codePoint);
        }
    }
    flush();
    if (parts.length === 0) {
        return { text: '""', kind: 'atom' };
    }
    // adjacent character classes and strings don't need a separator
    return { text: parts.join(''), kind: parts.length === 1 ? 'atom' : 'sequence' };
}

/**
 * Converts a list of characters and character ranges into a BNF character class.
 */
export function characterClassToBnf(members: Array<[from: string, to: string]>, negated = false): BnfFragment {
    const ranges = normalize(members.map(([from, to]) => [from.codePointAt(0)!, to.codePointAt(0)!]));
    return { text: rangesToBnf(negated ? complement(ranges) : ranges), kind: 'atom' };
}

/**
 * Appends a cardinality like `*` or `{2,3}` to the fragment, which is parenthesized if necessary.
 */
export function withCardinality(fragment: BnfFragment, cardinality: string, padding = ''): BnfFragment {
    if (fragment.text.length === 0) {
        return fragment;
    }
    // only a cardinality ends with one of these characters, as strings and character classes are delimited
    const atomic = fragment.kind === 'atom' && !/[*+?}]$/.test(fragment.text);
    return { text: (atomic ? fragment.text : `(${padding}${fragment.text}${padding})`) + cardinality, kind: 'atom' };
}

/**
 * Surrounds the fragment with parentheses unless it is atomic.
 */
export function toAtom(fragment: BnfFragment): string {
    return fragment.kind === 'atom' || fragment.text.length === 0 ? fragment.text : `(${fragment.text})`;
}

interface TranslatorFlags {
    ignoreCase: boolean;
    dotAll: boolean;
    warn: (message: string) => void;
}

class RegexTranslator {

    private readonly parser = new RegExpParser();

    constructor(private readonly source: string, private readonly flags: TranslatorFlags) { }

    translate(): BnfFragment {
        return this.disjunction(this.parser.pattern(this.source).value);
    }

    private disjunction(disjunction: Disjunction): BnfFragment {
        const alternatives = disjunction.value.map(alternative => this.alternative(alternative));
        if (alternatives.length === 1) {
            return alternatives[0];
        }
        return {
            text: alternatives.map(alternative => alternative.text.length > 0 ? alternative.text : '""').join(' | '),
            kind: 'alternatives'
        };
    }

    private alternative(alternative: Alternative): BnfFragment {
        const parts: BnfFragment[] = [];
        let literal = '';
        const flush = () => {
            if (literal.length > 0) {
                parts.push(literalToBnf(literal, this.flags.ignoreCase));
                literal = '';
            }
        };
        for (const term of alternative.value) {
            if (term.type === 'Character' && !term.quantifier) {
                // collect plain characters into a single string literal
                literal += String.fromCodePoint(term.value);
            } else {
                flush();
                const part = this.term(term);
                if (part.text.length > 0) {
                    parts.push(part);
                }
            }
        }
        flush();
        if (parts.length === 0) {
            return EMPTY;
        } else if (parts.length === 1) {
            return parts[0];
        }
        return { text: parts.map(part => part.kind === 'alternatives' ? `(${part.text})` : part.text).join(' '), kind: 'sequence' };
    }

    private term(term: Term): BnfFragment {
        switch (term.type) {
            case 'StartAnchor':
            case 'EndAnchor':
                // terminals are anchored implicitly
                return EMPTY;
            case 'WordBoundary':
            case 'NonWordBoundary':
            case 'Lookahead':
            case 'NegativeLookahead':
            case 'Lookbehind':
            case 'NegativeLookbehind':
                return this.assertion(term);
            default:
                return this.atom(term);
        }
    }

    private assertion(assertion: Assertion): BnfFragment {
        const text = this.source.substring(assertion.loc.begin, assertion.loc.end);
        this.flags.warn(`The assertion ${text} cannot be expressed in BNF and was dropped, the rule accepts more input than the regular expression.`);
        return EMPTY;
    }

    private atom(atom: Atom): BnfFragment {
        let fragment: BnfFragment;
        switch (atom.type) {
            case 'Character':
                fragment = literalToBnf(String.fromCodePoint(atom.value), this.flags.ignoreCase);
                break;
            case 'Set':
                fragment = { text: rangesToBnf(this.setRanges(atom)), kind: 'atom' };
                break;
            case 'Group': {
                const content = this.disjunction(atom.value);
                fragment = content.text.length === 0 ? EMPTY : { text: toAtom(content), kind: 'atom' };
                break;
            }
            case 'GroupBackReference':
                this.flags.warn(`The back reference \\${atom.value} cannot be expressed in BNF and was dropped: ${this.source}`);
                return EMPTY;
        }
        return atom.quantifier ? withCardinality(fragment, quantifierToBnf(atom.quantifier)) : fragment;
    }

    private setRanges(set: RegExpSet): CodeRange[] {
        const begin = set.loc.begin;
        if (this.source.charAt(begin) === '.') {
            return this.flags.dotAll ? [[0, MAX_CODE_POINT]] : complement(valuesToRanges(set.value));
        }
        // shorthand character classes like `\w` or `\S` are sets as well
        const { ranges, negated } = this.source.charAt(begin) === '['
            ? this.characterClassRanges(set)
            : { ranges: valuesToRanges(set.value), negated: set.complement };
        const members = this.flags.ignoreCase ? normalize(closeOverCase(ranges)) : ranges;
        return negated ? complement(members) : members;
    }

    /**
     * The regular expression parser treats the negated shorthand classes `\S`, `\W` and `\D` within a character class
     * like their positive counterparts. This means `[\s\S]` would match whitespace only, so they are handled here.
     */
    private characterClassRanges(set: RegExpSet): { ranges: CodeRange[], negated: boolean } {
        const begin = set.loc.begin;
        const negated = this.source.charAt(begin + 1) === '^';
        let remaining = '';
        let negatedShorthands: CodeRange[] = [];
        let index = begin + (negated ? 2 : 1);
        for (; index < this.source.length && this.source.charAt(index) !== ']'; index++) {
            const char = this.source.charAt(index);
            if (char === '\\') {
                const escaped = this.source.charAt(++index);
                if (escaped === 'S' || escaped === 'W' || escaped === 'D') {
                    negatedShorthands = negatedShorthands.concat(complement(this.shorthandRanges(escaped.toLowerCase())));
                } else {
                    remaining += char + escaped;
                }
            } else {
                remaining += char;
            }
        }
        if (negatedShorthands.length === 0) {
            return { ranges: valuesToRanges(set.value), negated };
        }
        const others = remaining.length > 0 ? this.parseSet(`/[${remaining}]/`).value : [];
        return { ranges: normalize(valuesToRanges(others).concat(negatedShorthands)), negated };
    }

    private shorthandRanges(shorthand: string): CodeRange[] {
        return valuesToRanges(this.parseSet(`/\\${shorthand}/`).value);
    }

    private parseSet(regex: string): RegExpSet {
        return this.parser.pattern(regex).value.value[0].value[0] as RegExpSet;
    }
}

function quantifierToBnf(quantifier: Quantifier): string {
    const { atLeast, atMost } = quantifier;
    const unbounded = atMost === Infinity || atMost === null || atMost === undefined;
    if (unbounded) {
        return atLeast === 0 ? '*' : atLeast === 1 ? '+' : `{${atLeast},}`;
    } else if (atLeast === 0 && atMost === 1) {
        return '?';
    } else if (atLeast === atMost) {
        return `{${atLeast}}`;
    }
    return `{${atLeast},${atMost}}`;
}

function rangesToBnf(ranges: CodeRange[]): string {
    if (ranges.length === 1 && ranges[0][0] === 0 && ranges[0][1] === MAX_CODE_POINT) {
        return '.';
    }
    // prefer the shorter notation, a set reaching the last code point is usually written as negation
    const negate = ranges.length > 0 && ranges[ranges.length - 1][1] === MAX_CODE_POINT;
    const content = (negate ? complement(ranges) : ranges).map(([from, to]) => {
        if (from === to) {
            return escapeInClass(from);
        }
        // a range of two characters doesn't need a dash
        return escapeInClass(from) + (to - from > 1 ? '-' : '') + escapeInClass(to);
    }).join('');
    return `[${negate ? '^' : ''}${content}]`;
}

function escapeInString(codePoint: number): string {
    const char = String.fromCodePoint(codePoint);
    return char === '"' || char === '\\' ? '\\' + char : escapeNonPrintable(codePoint);
}

function escapeInClass(codePoint: number): string {
    const char = String.fromCodePoint(codePoint);
    if (char === '^') {
        // there's no escape sequence for the caret, but it negates the class at the first position
        return '\\x5E';
    }
    return char === '[' || char === ']' || char === '\\' || char === '-' ? '\\' + char : escapeNonPrintable(codePoint);
}

function escapeNonPrintable(codePoint: number): string {
    if (codePoint >= 0x20 && codePoint <= 0x7E) {
        return String.fromCodePoint(codePoint);
    }
    switch (codePoint) {
        case 0x09: return '\\t';
        case 0x0A: return '\\n';
        case 0x0D: return '\\r';
    }
    const hex = codePoint.toString(16).toUpperCase();
    if (codePoint <= 0xFF) {
        return '\\x' + hex.padStart(2, '0');
    } else if (codePoint <= 0xFFFF) {
        return '\\u' + hex.padStart(4, '0');
    }
    return '\\U' + hex.padStart(8, '0');
}

function caseVariants(codePoint: number): number[] {
    const char = String.fromCodePoint(codePoint);
    const variants = new Set<number>([codePoint]);
    for (const variant of [char.toLowerCase(), char.toUpperCase()]) {
        // ignore case mappings to multiple characters, e.g. `ß` to `SS`
        if ([...variant].length === 1) {
            variants.add(variant.codePointAt(0)!);
        }
    }
    return [...variants].sort((a, b) => a - b);
}

function closeOverCase(ranges: CodeRange[]): CodeRange[] {
    const result: CodeRange[] = [...ranges];
    for (const [from, to] of ranges) {
        // large ranges are usually the result of a negation and are not closed over case
        if (to - from <= 0x800) {
            for (let codePoint = from; codePoint <= to; codePoint++) {
                for (const variant of caseVariants(codePoint)) {
                    result.push([variant, variant]);
                }
            }
        }
    }
    return result;
}

function valuesToRanges(values: RegExpSet['value']): CodeRange[] {
    return normalize(values.map(value => typeof value === 'number' ? [value, value] : [value.from, value.to]));
}

function normalize(ranges: CodeRange[]): CodeRange[] {
    const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
    const result: CodeRange[] = [];
    for (const [from, to] of sorted) {
        const last = result[result.length - 1];
        if (last && from <= last[1] + 1) {
            last[1] = Math.max(last[1], to);
        } else {
            result.push([from, to]);
        }
    }
    return result;
}

function complement(ranges: CodeRange[]): CodeRange[] {
    const result: CodeRange[] = [];
    let next = 0;
    for (const [from, to] of normalize(ranges)) {
        if (from > next) {
            result.push([next, from - 1]);
        }
        next = to + 1;
    }
    if (next <= MAX_CODE_POINT) {
        result.push([next, MAX_CODE_POINT]);
    }
    return result;
}
