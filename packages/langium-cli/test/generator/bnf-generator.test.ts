/******************************************************************************
 * Copyright 2025 TypeFox GmbH
 * This program and the accompanying materials are made available under the
 * terms of the MIT License, which is available in the project root.
 ******************************************************************************/

import type { Grammar } from 'langium';
import { EmptyFileSystem } from 'langium';
import { expandToStringWithNL } from 'langium/generate';
import { createLangiumGrammarServices } from 'langium/grammar';
import { parseHelper } from 'langium/test';
import { describe, expect, test } from 'vitest';
import { generateBnf } from '../../src/generator/bnf-generator.js';

const { grammar } = createLangiumGrammarServices(EmptyFileSystem);

describe('BNF generator', () => {

    test('GBNF - Simple grammar', async () => {
        const result = await parseGrammar(TEST_GRAMMAR);
        const generated = generateBnf([result.value]);
        expect(generated).toBe(EXPECTED_BNF);
    });

    test('GBNF - Fragment, comment generation', async () => {
        const result = await parseGrammar(GRAMMAR_WITH_FRAGMENT);
        const generated = generateBnf([result.value]);
        const expected = expandToStringWithNL`
        # * This is a root rule
        root ::= package-declaration* hidden*

        # * This is a package declaration * Using parser rule fragment
        package-declaration ::= hidden* "package" named-element hidden* "{" hidden* "}"

        named-element ::= qualified-name

        qualified-name ::= id ( hidden* "." id )*

        # * Terminal fragment
        number ::= [0-9]+

        # * Terminal using fragment
        signed-number ::= hidden* [+\\-] number+

        # Terminal rule
        id ::= hidden* [A-z]*

        ws ::= [\\t-\\r \\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+

        hidden ::= ( ws )
        `;
        expect(generated).toBe(expected);
    });

    test('EBNF - Fragment, comment generation', async () => {
        const result = await parseGrammar(GRAMMAR_WITH_FRAGMENT);
        const generated = generateBnf([result.value], { dialect: 'EBNF' });
        const expected = expandToStringWithNL`
        (* * This is a root rule *)
        <Domainmodel> ::= <PackageDeclaration>* <HIDDEN>*

        (* * This is a package declaration * Using parser rule fragment *)
        <PackageDeclaration> ::= <HIDDEN>* "package" <NamedElement> <HIDDEN>* "{" <HIDDEN>* "}"

        <NamedElement> ::= <QualifiedName>

        <QualifiedName> ::= <ID> ( <HIDDEN>* "." <ID> )*

        (* * Terminal fragment *)
        <NUMBER> ::= [0-9]+

        (* * Terminal using fragment *)
        <SIGNED_NUMBER> ::= <HIDDEN>* [+\\-] <NUMBER>+

        (* Terminal rule *)
        <ID> ::= <HIDDEN>* [A-z]*

        <WS> ::= [\\t-\\r \\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+

        <HIDDEN> ::= ( <WS> )
        `;
        expect(generated).toBe(expected);
    });

    test('GBNF - No hidden rules', async () => {
        const grammarContent = expandToStringWithNL`
        grammar RootLang
        entry Root:
            'root' name=ID;
        terminal ID: /[_a-zA-Z][\\w_]*/;
        `;

        const result = await parseGrammar(grammarContent);
        const generated = generateBnf([result.value]);
        const expected = expandToStringWithNL`
        root ::= "root" id

        id ::= [A-Z_a-z] [0-9A-Z_a-z]*

        `;
        expect(generated).toBe(expected);
    });
    test('GBNF - No hidden rules', async () => {
        const grammarContent = expandToStringWithNL`
        grammar RootLang
        entry Root:
            'root' name=ID;
        terminal ID: /[_a-zA-Z][\\w_]*/;
        `;

        const result = await parseGrammar(grammarContent);
        const generated = generateBnf([result.value]);
        const expected = expandToStringWithNL`
        root ::= "root" id

        id ::= [A-Z_a-z] [0-9A-Z_a-z]*

        `;
        expect(generated).toBe(expected);
    });

    test('EBNF - Slash comments', async () => {
        const grammarContent = expandToStringWithNL`
        grammar RootLang
        /* This is a root rule */
        entry Root: 'root' name=ID;
        
        /* This is a terminal rule */
        terminal ID: /[_a-zA-Z][\\w_]*/;
        `;

        const result = await parseGrammar(grammarContent);
        const generated = generateBnf([result.value], { dialect: 'EBNF', commentStyle: 'slash' });
        const expected = expandToStringWithNL`
        /* This is a root rule */
        <Root> ::= "root" <ID>

        /* This is a terminal rule */
        <ID> ::= [A-Z_a-z] [0-9A-Z_a-z]*

        `;
        expect(generated).toBe(expected);
    });

    test('Check RegEx Terminal rule escape', async () => {
        const grammarContent = expandToStringWithNL`
        grammar RootLang
        entry Root: 'root' name=ID;

        terminal ID: /[_a-zA-Z][\\w_]*/;
        
        terminal NUMBER: /[0-9]+/ | /[0-9]+(\\.[0-9]*)/;
        
        hidden terminal ML_COMMENT: /\\/\\*[\\s\\S]*?\\*\\//;
        hidden terminal SL_COMMENT: /\\/\\/[^\\n\\r]*/;
        `;

        const result = await parseGrammar(grammarContent);
        const generated = generateBnf([result.value]);
        const expected = expandToStringWithNL`
        root ::= hidden* "root" id hidden*

        id ::= hidden* [A-Z_a-z] [0-9A-Z_a-z]*

        number ::= hidden* ([0-9]+ | [0-9]+ ("." [0-9]*))

        ml-comment ::= "/*" .* "*/"

        sl-comment ::= "//" [^\\n\\r]*

        hidden ::= ( ml-comment | sl-comment )
        `;
        expect(generated).toBe(expected);
    });

    test('Parser Rule parameter', async () => {
        const grammarContent = expandToStringWithNL`
        grammar Test
        entry Model:
            element1=Element<false, false>
            element2=Element<false, true>
            element3=Element<true, false>
            element4=Element<true, true>
        ;
        Element<a,b>:
            (<a> "a")
            (<!a> "!a")
            (<a&b> "ab")
            (<a|b> "a_b")
            (<!(a&b)> '!ab')
            (<a> "a" | <b> "b")
            name="name"
            elements+=Element<false | a, b & true>*
        ';';
        `;

        const result = await parseGrammar(grammarContent);
        const generated = generateBnf([result.value]);
        const expected = expandToStringWithNL`
        root ::= element element-b element-a element-ab

        element ::= "!a" "!ab" "name" element* ";"
        element-a ::= "a" "a_b" "!ab" ("a") "name" element-a* ";"
        element-b ::= "!a" "a_b" "!ab" ("b") "name" element-b* ";"
        element-ab ::= "a" "ab" "a_b" ("a" | "b") "name" element-ab* ";"

        `;
        expect(generated).toBe(expected);
    });

    test('Rule names are unique', async () => {
        const grammarContent = expandToStringWithNL`
        grammar Test
        entry Model: values+=StringLiteral* hidden=Hidden?;
        StringLiteral: value=STRING_LITERAL;
        Hidden: 'hidden' Root;
        Root: 'root';
        terminal STRING_LITERAL: /"[^"]*"/;
        hidden terminal WS: /[ ]+/;
        `;

        const result = await parseGrammar(grammarContent);
        const generated = generateBnf([result.value]);
        const expected = expandToStringWithNL`
        root ::= string-literal* hidden-2? hidden*

        string-literal ::= string-literal-token

        hidden-2 ::= hidden* "hidden" root-2

        root-2 ::= hidden* "root"

        string-literal-token ::= hidden* "\\"" [^"]* "\\""

        ws ::= [ ]+

        hidden ::= ( ws )
        `;
        expect(generated).toBe(expected);
    });

    test('Case insensitive keywords', async () => {
        const grammarContent = expandToStringWithNL`
        grammar Test
        entry Model: 'print' value=ID 'to'? target=('file1' | '>>');
        terminal ID: /[a-z]+/;
        `;

        const result = await parseGrammar(grammarContent);
        const generated = generateBnf([result.value], { dialect: 'GBNF', caseInsensitive: true });
        const expected = expandToStringWithNL`
        root ::= [Pp][Rr][Ii][Nn][Tt] id ( [Tt][Oo] )? ([Ff][Ii][Ll][Ee]"1" | ">>")

        id ::= [a-z]+

        `;
        expect(generated).toBe(expected);
    });

    test('Keywords are escaped and keep their cardinality', async () => {
        const grammarContent = expandToStringWithNL`
        grammar Test
        entry Model: 'let'? quote='"' backslash='\\\\'+ ';'*;
        hidden terminal WS: /[ ]+/;
        `;

        const result = await parseGrammar(grammarContent);
        const generated = generateBnf([result.value]);
        const expected = expandToStringWithNL`
        root ::= ( hidden* "let" )? hidden* "\\"" ( hidden* "\\\\" )+ ( hidden* ";" )* hidden*

        ws ::= [ ]+

        hidden ::= ( ws )
        `;
        expect(generated).toBe(expected);
    });

    test('RegEx terminal rules are translated', async () => {
        const grammarContent = expandToStringWithNL`
        grammar Test
        entry Model: values+=(COMMENT | NUMBER | ANY | NOT_WORD | HEX | LAZY | QUOTED)*;
        terminal COMMENT: /rem(?![\\w$])[^\\n\\r]*$/i;
        terminal NUMBER: /[0-9]+(\\.[0-9]*)?|\\.[0-9]+/;
        terminal ANY: /<[\\s\\S]*?>|<.>/;
        terminal NOT_WORD: /[^\\w-]\\S[\\W\\d]/;
        terminal HEX: /\\$[0-9a-f]{2,4}\\$\\d{2}\\b/;
        terminal LAZY: /a+?b{3,}?/;
        terminal QUOTED: /"(\\\\.|[^"\\\\])*"|\\^\\[\\]/;
        `;

        const warnings: string[] = [];
        const result = await parseGrammar(grammarContent);
        const generated = generateBnf([result.value], { dialect: 'GBNF', onWarning: message => warnings.push(message) });
        const expected = expandToStringWithNL`
        root ::= (comment | number | any | not-word | hex | lazy | quoted)*

        # The assertion (?![\\w$]) cannot be expressed in BNF and was dropped, the rule accepts more input than the regular expression.
        comment ::= [Rr][Ee][Mm] [^\\n\\r]*

        number ::= [0-9]+ ("." [0-9]*)? | "." [0-9]+

        any ::= "<" .* ">" | "<" [^\\n\\r\\u2028\\u2029] ">"

        not-word ::= [^\\-0-9A-Z_a-z] [^\\t-\\r \\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF] [^A-Z_a-z]

        # The assertion \\b cannot be expressed in BNF and was dropped, the rule accepts more input than the regular expression.
        hex ::= "$" [0-9a-f]{2,4} "$" [0-9]{2}

        lazy ::= "a"+ "b"{3,}

        quoted ::= "\\"" ("\\\\" [^\\n\\r\\u2028\\u2029] | [^"\\\\])* "\\"" | "^[]"

        `;
        expect(generated).toBe(expected);
        expect(warnings).toHaveLength(2);
        expect(warnings[0]).toContain('COMMENT: The assertion (?![\\w$])');
    });

    test('Terminal rules without RegEx', async () => {
        const grammarContent = expandToStringWithNL`
        grammar Test
        entry Model: values+=(ARROW | LETTER | ML_COMMENT | NO_QUOTE | TWO | WORD)*;
        terminal ARROW: '=>';
        terminal LETTER: 'a'..'z' | 'A'..'Z';
        terminal ML_COMMENT: '/*' -> '*/';
        terminal NO_QUOTE: '<' !('"' | 'a'..'c')* '>';
        terminal TWO: . . (?='x');
        terminal WORD: LETTER+ ARROW;
        `;

        const warnings: string[] = [];
        const result = await parseGrammar(grammarContent);
        const generated = generateBnf([result.value], { dialect: 'GBNF', onWarning: message => warnings.push(message) });
        const expected = expandToStringWithNL`
        root ::= (arrow | letter | ml-comment | no-quote | two | word)*

        arrow ::= "=>"

        letter ::= ([a-z] | [A-Z])

        ml-comment ::= "/*" .* "*/"

        no-quote ::= "<" [^"a-c]* ">"

        # The lookahead (?='x') cannot be expressed in BNF and was dropped, the rule accepts more input than the terminal.
        two ::= . .

        word ::= ([a-z] | [A-Z])+ "=>"

        `;
        expect(generated).toBe(expected);
        expect(warnings).toHaveLength(1);
    });

    test('Rule overrides', async () => {
        const grammarContent = expandToStringWithNL`
        grammar Test
        entry Model: 'print' value=ID? end=EOL;
        terminal EOL: /_eol_/;
        terminal ID: /_id_/;
        hidden terminal WS: /\\s+/;
        `;

        const result = await parseGrammar(grammarContent);
        const generated = generateBnf([result.value], {
            dialect: 'GBNF',
            overrides: {
                EOL: /;|\r?\n/,
                ID: '[a-z]+ # custom',
                WS: /[ \t]+/
            }
        });
        const expected = expandToStringWithNL`
        root ::= hidden* "print" id? eol hidden*

        eol ::= hidden* (";" | "\\r"? "\\n")

        id ::= [a-z]+ # custom

        ws ::= [\\t ]+

        hidden ::= ( ws )
        `;
        expect(generated).toBe(expected);
    });

    test('Infix rule', async () => {
        const grammarContent = expandToStringWithNL`
        grammar Test
        entry Model: expr=Expression;
        infix Expression on Primary: '*' | '/' > '+' | '-';
        Primary: value=NUMBER;
        terminal NUMBER: /[0-9]+/;
        hidden terminal WS: /[ ]+/;
        `;

        const result = await parseGrammar(grammarContent);
        const generated = generateBnf([result.value]);
        const expected = expandToStringWithNL`
        root ::= expression hidden*

        expression ::= primary ( (hidden* "*" | hidden* "/" | hidden* "+" | hidden* "-") primary )*

        primary ::= number

        number ::= hidden* [0-9]+

        ws ::= [ ]+

        hidden ::= ( ws )
        `;
        expect(generated).toBe(expected);
    });

});

const EXPECTED_BNF = expandToStringWithNL`
root ::= hidden* "module" id statement* hidden*

statement ::= (definition | evaluation)

definition ::= hidden* "def" id ( hidden* "(" declared-parameter ( hidden* "," declared-parameter )* hidden* ")" )? hidden* ":" expression hidden* ";"

declared-parameter ::= id

evaluation ::= expression hidden* ";"

expression ::= addition

addition ::= multiplication ( (hidden* "+" | hidden* "-") multiplication )*

multiplication ::= primary-expression ( (hidden* "*" | hidden* "/") primary-expression )*

primary-expression ::= (hidden* "(" expression hidden* ")" | number | id ( hidden* "(" expression ( hidden* "," expression )* hidden* ")" )?)

ws ::= [\\t-\\r \\xA0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+

id ::= hidden* [A-Z_a-z] [0-9A-Z_a-z]*

number ::= hidden* [0-9]+ ("." [0-9]*)?

ml-comment ::= "/*" .* "*/"

sl-comment ::= "//" [^\\n\\r]*

hidden ::= ( ws | ml-comment | sl-comment )
`;

const TEST_GRAMMAR = expandToStringWithNL`
    grammar Arithmetics

    entry Module:
        'module' name=ID
        (statements+=Statement)*;

    Statement:
        Definition | Evaluation;

    Definition:
        'def' name=ID ('(' args+=DeclaredParameter (',' args+=DeclaredParameter)* ')')?
        ':' expr=Expression ';';

    DeclaredParameter:
        name=ID;

    type AbstractDefinition = Definition | DeclaredParameter;

    Evaluation:
        expression=Expression ';';

    Expression:
        Addition;

    Addition infers Expression:
        Multiplication ({infer BinaryExpression.left=current} operator=('+' | '-') right=Multiplication)*;

    Multiplication infers Expression:
        PrimaryExpression ({infer BinaryExpression.left=current} operator=('*' | '/') right=PrimaryExpression)*;

    PrimaryExpression infers Expression:
        '(' Expression ')' |
        {infer NumberLiteral} value=NUMBER |
        {infer FunctionCall} func=[AbstractDefinition] ('(' args+=Expression (',' args+=Expression)* ')')?;

    hidden terminal WS: /\\s+/;
    terminal ID: /[_a-zA-Z][\\w_]*/;
    terminal NUMBER returns number: /[0-9]+(\\.[0-9]*)?/;

    hidden terminal ML_COMMENT: /\\/\\*[\\s\\S]*?\\*\\//;
    hidden terminal SL_COMMENT: /\\/\\/[^\\n\\r]*/;
`;

const GRAMMAR_WITH_FRAGMENT = expandToStringWithNL`
    grammar DomainModel
    /** This is a root rule */
    entry Domainmodel:
        (elements+=PackageDeclaration)*;

    /*
    * This is a package declaration
    * Using parser rule fragment
    */
    PackageDeclaration:
        'package' NamedElement '{'
        '}';

    fragment NamedElement:
        name=QualifiedName
    ;

    // Datatype rule
    QualifiedName returns string:
        ID ('.' ID)*;

    /** Terminal fragment */
    terminal fragment NUMBER: /[0-9]+/;
    /** Terminal using fragment */
    terminal SIGNED_NUMBER returns number: /[+-]/ NUMBER+;
    /* Terminal rule */
    terminal ID: /[A-z]*/;
    hidden terminal WS: /\\s+/;
`;

async function parseGrammar(grammarContent: string) {
    const result = (await parseHelper<Grammar>(grammar)(grammarContent)).parseResult;
    expect(result.lexerErrors.length, `Grammar contains ${result.lexerErrors.length} lexer error/-s: ${result.lexerErrors[0]?.message}`)
        .toBe(0);
    return result;
}

