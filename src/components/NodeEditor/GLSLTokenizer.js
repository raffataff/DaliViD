export const setupGLSLMonaco = (monaco) => {
  monaco.languages.register({ id: 'glsl' })

  monaco.languages.setMonarchTokensProvider('glsl', {
    defaultToken: '',
    tokenPostfix: '.glsl',

    keywords: [
      'attribute', 'const', 'uniform', 'varying',
      'break', 'continue', 'do', 'for', 'while',
      'if', 'else', 'in', 'out', 'inout',
      'float', 'int', 'void', 'bool', 'true', 'false',
      'lowp', 'mediump', 'highp', 'precision',
      'invariant', 'discard', 'return',
      'mat2', 'mat3', 'mat4',
      'vec2', 'vec3', 'vec4', 'ivec2', 'ivec3', 'ivec4',
      'bvec2', 'bvec3', 'bvec4',
      'sampler2D', 'samplerCube',
      'struct'
    ],

    builtins: [
      'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
      'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt',
      'abs', 'sign', 'floor', 'ceil', 'fract', 'mod', 'min', 'max', 'clamp', 'mix', 'step', 'smoothstep',
      'length', 'distance', 'dot', 'cross', 'normalize', 'faceforward', 'reflect', 'refract',
      'matrixCompMult', 'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual',
      'equal', 'notEqual', 'any', 'all', 'not',
      'texture2D', 'textureCube', 'texture2DProj', 'texture2DLod', 'textureCubeLod', 'texture',
      'gl_FragCoord', 'gl_FragColor', 'gl_Position', 'gl_PointSize', 'gl_FrontFacing'
    ],

    operators: [
      '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=',
      '&&', '||', '++', '--', '+', '-', '*', '/', '&', '|', '^', '%',
      '<<', '>>', '+=', '-=', '*=', '/=', '&=', '|=', '^=',
      '%=', '<<=', '>>='
    ],

    symbols: /[=><!~?:&|+\-*/^%]+/,

    tokenizer: {
      root: [
        // Custom Dalivid param directive
        [new RegExp('^[/][/]\\\\s*\\\\x40param.*$'), 'annotation'],
        
        // Identifiers and keywords
        [/[a-zA-Z_]\w*/, {
          cases: {
            '@keywords': 'keyword',
            '@builtins': 'type.identifier',
            '@default': 'identifier'
          }
        }],

        // Whitespace
        { include: '@whitespace' },

        // Preprocessor
        [/#.*$/, 'meta'],

        // Numbers
        [/\d*\.\d+([eE][-+]?\d+)?/, 'number.float'],
        [/0[xX][0-9a-fA-F]+/, 'number.hex'],
        [/\d+/, 'number'],

        // Delimiters and operators
        [/[{}()[\]]/, '@brackets'],
        [/[<>](?!@symbols)/, '@brackets'],
        [/@symbols/, {
          cases: {
            '@operators': 'operator',
            '@default': ''
          }
        }],
      ],

      whitespace: [
        [/[ \t\r\n]+/, 'white'],
        [new RegExp('[/][*]'), 'comment', '@comment'],
        [new RegExp('[/][/].*$'), 'comment'],
      ],

      comment: [
        [/[^/*]+/, 'comment'],
        [new RegExp('[*][/]'), 'comment', '@pop'],
        [/[/*]/, 'comment']
      ],
    },
  })

  // Theme definition
  monaco.editor.defineTheme('dalivid-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '569cd6', fontStyle: 'bold' },
      { token: 'type.identifier', foreground: '4ec9b0' },
      { token: 'identifier', foreground: 'd4d4d4' },
      { token: 'number.float', foreground: 'b5cea8' },
      { token: 'number', foreground: 'b5cea8' },
      { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
      { token: 'meta', foreground: 'c586c0' }, // Preprocessor
      { token: 'annotation', foreground: 'ce9178', fontStyle: 'bold' }, // @param
    ],
    colors: {
      'editor.background': '#141418', // Matches --bg-primary
      'editor.foreground': '#d4d4d4',
      'editorLineNumber.foreground': '#555566',
      'editor.selectionBackground': '#264f78',
      'editor.lineHighlightBackground': '#222230',
      'editorCursor.foreground': '#00e5ff',
      'editorIndentGuide.background': '#2a2a35',
    }
  })
}
