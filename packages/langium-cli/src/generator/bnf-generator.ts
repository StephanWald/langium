/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import { CstUtils, GrammarAST as ast, type Grammar } from 'langium';
import { EOL } from 'langium/generate';
import _ from 'lodash';
import { characterClassToBnf, literalToBnf, regexToBnf, toAtom, withCardinality, type BnfFragment } from './bnf-regexp.js';

/** Key of the generated rule that collects the hidden terminal rules. It can't collide with the name of a grammar rule. */
const HIDDEN = '<HIDDEN>';
const EMPTY: BnfFragment = { text: '', kind: 'sequence' };
const ANY_CHARACTER: BnfFragment = { text: '.', kind: 'atom' };

export function generateBnf(grammars: Grammar[], options: GeneratorOptions = { dialect: 'GBNF' }): string {
    const grammarsWithName = grammars.filter(grammar => !!grammar.name);
    const rules = grammarsWithName.flatMap(grammar => grammar.rules);

    const isHiddenTerminalRule = (rule: ast.AbstractRule): boolean => {
        return ast.isTerminalRule(rule) && rule.hidden;
    };
    const hiddenRules = rules.filter(isHiddenTerminalRule);

    const ctx: GeneratorContext = {
        ...options,
        hasHiddenRules: hiddenRules.length > 0,
        commentStyle: options.commentStyle ?? (options.dialect === 'GBNF' ? 'hash' : 'parentheses'),
        entryRule: rules.find(rule => ast.isParserRule(rule) && rule.entry),
        names: new Map(),
        notes: [],
        onWarning: options.onWarning ?? (message => console.warn(message))
    };
    assignNames(rules, ctx);

    let result: string = '';
    rules.forEach(rule => {
        result += processRule(rule, ctx);
        result += EOL + EOL;
    });

    if (hiddenRules.length > 0) {
        result += `${processName(HIDDEN, ctx)} ::= ( ${hiddenRules.map(rule => processName(rule.name, ctx)).join(' | ')} )${EOL}`;
    }
    return result;
}

function processRule(rule: ast.AbstractRule, ctx: GeneratorContext): string {
    const ruleComment = processComment(rule, ctx);
    if (ast.isParserRule(rule) && rule.parameters.length > 0 && !hasOverride(rule, ctx)) {
        // parser rule with parameters
        const variations: Array<Record<string, boolean>> = parserRuleVariations(rule.parameters);
        return variations.map(variation => {
            const variationCtx = { ...ctx, parserRuleVariation: variation };
            return processRuleVariation(rule, ruleComment, variationCtx, variation);
        }).join(EOL);
    }
    return processRuleVariation(rule, ruleComment, ctx);
}

function processRuleVariation(rule: ast.AbstractRule, ruleComment: string, ctx: GeneratorContext, variation?: Record<string, boolean>): string {
    ctx.notes.length = 0;
    ctx.currentRule = rule;
    const body = processRuleBody(rule, ctx);
    const notes = ctx.commentStyle === 'skip' ? '' : ctx.notes.map(note => formatComment(note, ctx)).join('');
    return `${ruleComment}${notes}${processName(rule.name, ctx, variation)} ::= ${body}`;
}

function processRuleBody(rule: ast.AbstractRule, ctx: GeneratorContext): string {
    const override = ctx.overrides?.[rule.name];
    if (typeof override === 'string') {
        return override;
    }
    let body: BnfFragment;
    if (override) {
        body = regexToBnf(override, { onWarning: message => warn(message, ctx) });
    } else if (ast.isInfixRule(rule)) {
        body = processInfix(rule, ctx);
    } else {
        body = processElement(rule.definition, ctx);
    }
    // GBNF doesn't know hidden tokens, so they are accepted in front of each token and at the end of the input.
    const hiddenPrefix = (ast.isTerminalRule(rule) && !rule.hidden && !rule.fragment) ? hiddenRuleCall(ctx) : '';
    const hiddenSuffix = (rule === ctx.entryRule && ctx.hasHiddenRules) ? ` ${processName(HIDDEN, ctx)}*` : '';
    if (hiddenPrefix.length > 0 || hiddenSuffix.length > 0) {
        return `${hiddenPrefix}${sequenceMember(body)}${hiddenSuffix}`;
    }
    return body.text;
}

function hasOverride(rule: ast.AbstractRule, ctx: GeneratorContext): boolean {
    return ctx.overrides?.[rule.name] !== undefined;
}

function processInfix(rule: ast.InfixRule, ctx: GeneratorContext): BnfFragment {
    const variation = collectArguments(rule.call.rule.ref, rule.call.arguments, ctx);
    const ruleName = rule.call.rule.ref?.name ?? rule.call.rule.$refText;
    const call = processName(ruleName, ctx, variation);
    const operators = rule.operators.precedences.flatMap(prec => prec.operators.map(op => processKeyword(op.value, ctx).text));
    const allOperators = `(${operators.join(' | ')})`;
    return { text: `${call} ( ${allOperators} ${call} )*`, kind: 'sequence' };
}

function processElement(element: ast.AbstractElement, ctx: GeneratorContext): BnfFragment {
    if (ast.isTerminalElement(element) && element.lookahead) {
        warn(`The lookahead ${element.$cstNode?.text ?? element.lookahead} cannot be expressed in BNF and was dropped, the rule accepts more input than the terminal.`, ctx);
        return EMPTY;
    }
    const fragment = processElementContent(element, ctx);
    return element.cardinality ? withCardinality(fragment, element.cardinality, ' ') : fragment;
}

function processElementContent(element: ast.AbstractElement, ctx: GeneratorContext): BnfFragment {
    const processRecursively = (element: ast.AbstractElement) => {
        return processElement(element, ctx);
    };
    if (ast.isKeyword(element)) {
        return processKeyword(element.value, ctx);
    } else if (ast.isGroup(element) || ast.isTerminalGroup(element)) {
        if (ast.isGroup(element) && element.guardCondition && !evaluateCondition(element.guardCondition, ctx)) {
            // Skip group if guard condition is false
            return EMPTY;
        }
        const content = element.elements.map(processRecursively).filter(fragment => notEmpty(fragment.text));
        if (content.length === 1) {
            return content[0];
        }
        return { text: content.map(sequenceMember).join(' '), kind: 'sequence' };
    } else if (ast.isAssignment(element)) {
        return processRecursively(element.terminal);
    } else if (ast.isRuleCall(element)) {
        const variation = collectArguments(element.rule.ref, element.arguments, ctx);
        const ruleName = element.rule.ref?.name ?? element.rule.$refText;
        return { text: processName(ruleName, ctx, variation), kind: 'atom' };
    } else if (ast.isTerminalRuleCall(element)) {
        const rule = element.rule.ref;
        if (rule && !rule.fragment && !hasOverride(rule, ctx)) {
            // The rules of other terminals accept leading hidden tokens, so their definition is used instead.
            return { text: toAtom(processRecursively(rule.definition)), kind: 'atom' };
        }
        return { text: processName(rule?.name ?? element.rule.$refText, ctx), kind: 'atom' };
    } else if (ast.isAlternatives(element) || ast.isTerminalAlternatives(element)) {
        const content = element.elements.map(processRecursively).map(fragment => fragment.text).filter(notEmpty).join(' | ');
        if (notEmpty(content)) {
            return { text: '(' + content + ')', kind: 'atom' };
        }
        return EMPTY;
    } else if (ast.isUnorderedGroup(element)) {
        const content = element.elements.map(processRecursively).map(fragment => fragment.text).filter(notEmpty).join(' | ');
        warn('Unordered groups are generated as repeated alternatives, the rule accepts the elements multiple times.', ctx);
        return notEmpty(content) ? { text: `(${content})*`, kind: 'atom' } : EMPTY;
    } else if (ast.isRegexToken(element)) {
        return regexToBnf(element.regex, { onWarning: message => warn(message, ctx) });
    } else if (ast.isCharacterRange(element)) {
        if (element.right) {
            return characterClassToBnf([[element.left.value, element.right.value]]);
        }
        return literalToBnf(element.left.value);
    } else if (ast.isWildcard(element)) {
        return ANY_CHARACTER;
    } else if (ast.isNegatedToken(element)) {
        const characters = collectCharacters(element.terminal);
        if (characters) {
            return characterClassToBnf(characters, true);
        }
        warn(`The negated token ${element.$cstNode?.text ?? ''} cannot be expressed in BNF and was replaced by a wildcard, the rule accepts more input than the terminal.`, ctx);
        return ANY_CHARACTER;
    } else if (ast.isUntilToken(element)) {
        // The terminal ends at the first match of the end token, the generated rule accepts further matches in between.
        return { text: `${ANY_CHARACTER.text}* ${toAtom(processRecursively(element.terminal))}`, kind: 'sequence' };
    } else if (ast.isCrossReference(element)) {
        return element.terminal ? processRecursively(element.terminal) : { text: processName('ID', ctx), kind: 'atom' };
    } else if (ast.isAction(element) || ast.isEndOfFile(element)) {
        return EMPTY;
    }
    warn(`Not handled AbstractElement type: ${element?.$type}`, ctx);
    return EMPTY;
}

function processKeyword(value: string, ctx: GeneratorContext): BnfFragment {
    const keyword = literalToBnf(value, ctx.caseInsensitive);
    const hiddenPrefix = hiddenRuleCall(ctx);
    return hiddenPrefix.length > 0 ? { text: hiddenPrefix + keyword.text, kind: 'sequence' } : keyword;
}

/**
 * Collects the characters of an element matching a single character, i.e. a character, a character range or alternatives of those.
 */
function collectCharacters(element: ast.AbstractElement): Array<[string, string]> | undefined {
    if (element.cardinality) {
        return undefined;
    } else if (ast.isCharacterRange(element)) {
        if (element.right) {
            return [[element.left.value, element.right.value]];
        }
        return [...element.left.value].length === 1 ? [[element.left.value, element.left.value]] : undefined;
    } else if (ast.isTerminalAlternatives(element)) {
        const characters = element.elements.map(collectCharacters);
        return characters.every(entry => entry !== undefined) ? characters.flat() : undefined;
    }
    return undefined;
}

/**
 * Alternatives need to be parenthesized within a sequence.
 */
function sequenceMember(fragment: BnfFragment): string {
    return fragment.kind === 'alternatives' ? `(${fragment.text})` : fragment.text;
}

function warn(message: string, ctx: GeneratorContext): void {
    ctx.notes.push(message);
    ctx.onWarning(ctx.currentRule ? `${ctx.currentRule.name}: ${message}` : message);
}

/**
 * Assigns a unique name to each rule. GBNF rule names are dashed lowercase words, so different rule names
 * of the grammar like `StringLiteral` and `STRING_LITERAL` may result in the same name.
 */
function assignNames(rules: ast.AbstractRule[], ctx: GeneratorContext): void {
    const used = new Set<string>();
    const assign = (key: string, name: string, isTerminal = false) => {
        let formatted = formatName(name, ctx);
        if (isTerminal && used.has(formatted)) {
            formatted = formatName(`${name}_TOKEN`, ctx);
        }
        for (let index = 2; used.has(formatted); index++) {
            formatted = formatName(`${name}_${index}`, ctx);
        }
        used.add(formatted);
        ctx.names.set(key, formatted);
    };
    // GBNF expects 'root' as the root rule name, Lark e.g. expects 'start'.
    if (ctx.dialect === 'GBNF' && ctx.entryRule) {
        used.add('root');
        ctx.names.set(nameKey(ctx.entryRule.name), 'root');
    }
    if (ctx.hasHiddenRules) {
        assign(HIDDEN, 'HIDDEN');
    }
    // The names of parser rules take precedence over the names of terminal rules
    const terminalRules = rules.filter(ast.isTerminalRule);
    for (const rule of rules.filter(rule => !ast.isTerminalRule(rule))) {
        if (ast.isParserRule(rule) && rule.parameters.length > 0) {
            for (const variation of parserRuleVariations(rule.parameters)) {
                const key = nameKey(rule.name, variation);
                if (!ctx.names.has(key)) {
                    assign(key, rule.name + variationSuffix(variation));
                }
            }
        }
        if (!ctx.names.has(nameKey(rule.name))) {
            assign(nameKey(rule.name), rule.name);
        }
    }
    for (const rule of terminalRules) {
        assign(nameKey(rule.name), rule.name, true);
    }
}

function nameKey(ruleName: string, parserRuleVariation?: Record<string, boolean>): string {
    const suffix = parserRuleVariation ? variationSuffix(parserRuleVariation) : '';
    return suffix.length > 0 ? `${ruleName}<${suffix}>` : ruleName;
}

function variationSuffix(parserRuleVariation: Record<string, boolean>): string {
    return Object.entries(parserRuleVariation)
        .filter(entry => entry[1]).map(entry => entry[0].charAt(0).toUpperCase() + entry[0].slice(1))
        .join('');
}

function formatName(name: string, ctx: GeneratorContext): string {
    switch (ctx.dialect) {
        case 'GBNF':
            // convert camel case to Kebab Case for GBNF (GGML AI)
            return _.kebabCase(name) || 'rule';
        case 'EBNF':
            return `<${name}>`;
        default:
            return name;
    }
}

function processName(ruleName: string, ctx: GeneratorContext, parserRuleVariation?: Record<string, boolean>): string {
    return ctx.names.get(nameKey(ruleName, parserRuleVariation))
        ?? formatName(ruleName + (parserRuleVariation ? variationSuffix(parserRuleVariation) : ''), ctx);
}

function processComment(rule: ast.AbstractRule, ctx: GeneratorContext) {
    const comment = CstUtils.findCommentNode(rule.$cstNode, ['ML_COMMENT'])?.text
        ?.replace(/\r?\n|\r/g, ' ') // Replace line breaks
        ?.replace(/^\/\*\s*/, '')   // Remove leading `/*`
        ?.replace(/\s*\*\/$/, '');  // Remove trailing `*/`
    if (comment && comment.trim().length > 0) {
        return formatComment(comment, ctx);
    }
    return '';
}

function formatComment(comment: string, ctx: GeneratorContext): string {
    switch (ctx.commentStyle) {
        case 'skip':
            return ' ';
        case 'parentheses':
            return `(* ${comment.replace(/\*\)/g, '* )')} *)${EOL}`;
        case 'slash':
            return `/* ${comment.replace(/\*\//g, '* /')} */${EOL}`;
        case 'hash':
            return `# ${comment}${EOL}`;
    }
}

/**
 * Generates a call to the `HIDDEN` rule with a trailing space, if there are hidden rules in the grammar.
 * @param ctx GeneratorContext
 * @returns `HIDDEN* ` if there are hidden rules in the grammar.
 */
function hiddenRuleCall(ctx: GeneratorContext): string {
    return ctx.hasHiddenRules ? (processName(HIDDEN, ctx) + '* ') : '';
}

function notEmpty(text: string): boolean {
    return text.trim().length > 0;
}

/**
 * @param params parserRule parameters
 * @returns all possible combination of guards for the parserRule - 2^params.length
 */
function parserRuleVariations(params: ast.Parameter[]): Array<Record<string, boolean>> {
    const variationsCount = Math.pow(2, params.length);
    const variations: Array<Record<string, boolean>> = [];
    for (let i = 0; i < variationsCount; i++) {
        const variation: Record<string, boolean> = {};
        params.map((param, index) => {
            // eslint-disable-next-line no-bitwise
            const isTrue = (i & (1 << index)) !== 0;
            return variation[param.name] = isTrue;
        });
        variations.push(variation);
    }
    return variations;
}

function collectArguments(rule: ast.AbstractRule | undefined, namedArgs: ast.NamedArgument[], ctx: GeneratorContext): Record<string, boolean> | undefined {
    if (ast.isParserRule(rule) && namedArgs.length > 0 && rule.parameters.length === namedArgs.length) {
        const variation: Record<string, boolean> = {};
        namedArgs.forEach((arg, idx) => {
            variation[rule.parameters[idx].name] = evaluateCondition(arg.value, ctx);
        });
        return variation;
    }
    return undefined;
}

function evaluateCondition(condition: ast.Condition, ctx: GeneratorContext): boolean {
    switch (condition.$type) {
        case 'BooleanLiteral':
            return condition.true;
        case 'Conjunction':
            return evaluateCondition(condition.left, ctx) && evaluateCondition(condition.right, ctx);
        case 'Disjunction':
            return evaluateCondition(condition.left, ctx) || evaluateCondition(condition.right, ctx);
        case 'Negation':
            return !evaluateCondition(condition.value, ctx);
        case 'ParameterReference': {
            if (!ctx.parserRuleVariation) {
                return false;
            }
            return ctx.parserRuleVariation[condition.parameter.ref?.name ?? condition.parameter.$refText];
        }
        default:
            throw new Error(`Unhandled Condition type: ${(condition as ast.Condition).$type}`);
    }
}

/**
 * Default: GBNF
 * RegEx terminal rules are translated for both dialects. BNF cannot express lookaround assertions, so they are dropped with a warning.
 */
export type BnfDialect = 'GBNF' | 'EBNF';

/**
 * By default, comments are generated according to the dialect.
 * Use this option to force a specific comment style.
 * Use `parentheses` for `(* comment *)`, `slash` for `/* comment *\/`, `hash` for `# comment`
 * and `skip` to disable comment generation.
 */
export type CommentStyle = 'skip' | 'parentheses' | 'slash' | 'hash';

export type GeneratorOptions = {
    dialect: BnfDialect;
    commentStyle?: CommentStyle;
    /**
     * Matches keywords regardless of their case, like the `caseInsensitive` option of the language configuration.
     * Neither dialect has a notion of case insensitivity, so each letter becomes a character class, e.g. `[pP][rR][iI][nN][tT]`.
     */
    caseInsensitive?: boolean;
    /**
     * Replaces the definition of rules, by the name of the rule in the grammar. This is meant for languages that replace
     * the pattern of terminal rules in their `TokenBuilder`, so the grammar doesn't contain the actual definition.
     * A regular expression is translated like the regular expression of a terminal rule. A string is used as it is.
     */
    overrides?: Record<string, RegExp | string>;
    /**
     * Receives a message for each element that cannot be expressed in BNF. Such elements are dropped,
     * so the generated rule accepts more input than the rule of the grammar. By default, the messages are written to the console.
     */
    onWarning?: (message: string) => void;
};

type GeneratorContext = GeneratorOptions & {
    hasHiddenRules: boolean;
    commentStyle: CommentStyle;
    entryRule?: ast.AbstractRule;
    /** Names of the generated rules by the key of `nameKey()` */
    names: Map<string, string>;
    /** Warnings of the currently processed rule, they are added as comment to the generated rule. */
    notes: string[];
    currentRule?: ast.AbstractRule;
    onWarning: (message: string) => void;
    parserRuleVariation?: Record<string, boolean>;
};
