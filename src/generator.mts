import ts from "typescript";
import { factory } from "typescript";
import { AttributeLocal, type Path, Scope } from "./scope.mts";
import {
  LiteralType,
  ObjectType,
  PrimitiveType,
  ReferenceType,
  UnionType,
  type TypeModel,
} from "./model.mts";
import assert, { ok } from "node:assert";
import { unimplemented } from "./helpers.mts";

export class TypeGuardGenerator {
  guards: Map<string, ts.Statement>;
  constructor() {
    this.guards = new Map();
  }

  getAssertionsForLocalVar(
    scope: Scope,
    path: Path,
    target: AttributeLocal,
    typePath: string[],
    type: TypeModel
  ): ts.Statement[] {
    const targetPath = [...path, target.attribute_name];

    if (type instanceof ReferenceType) {
      return ifNotReturnFalse(
        assertionConditionForType(target.local_name, type)
      );
    } else if (type instanceof ObjectType) {
      const entries = Object.entries(type.attributes).map(
        ([attr, type]) =>
          [scope.createAttribute(targetPath, attr), type] as const
      );
      const attrs = entries.map(([local, _]) => local);
      return [
        ...assertIsObject(target.local_name),
        ...objectSpread(
          target.local_name,
          attrs,
          typePathToTypeSelector(typePath)
        ),
        ...entries.flatMap(([local, type]) => {
          return this.getAssertionsForLocalVar(
            scope,
            targetPath,
            local,
            [...typePath, local.attribute_name],
            type
          );
        }),
      ];
    } else if (type instanceof PrimitiveType) {
      return ifNotReturnFalse(
        assertionConditionForType(target.local_name, type)
      );
    } else if (type instanceof LiteralType) {
      return ifNotReturnFalse(
        assertionConditionForType(target.local_name, type)
      );
    } else if (type instanceof UnionType) {
      return ifNotReturnFalse(
        assertionConditionForType(target.local_name, type)
      );
    }

    unimplemented(`${(type as Object)?.constructor.name}`);
  }

  /**
   * It's a method because it's suppored to call itself for referenced types.
   */
  addTypeGuardFor(type: TypeModel): void {
    const typeName = type.options.aliasName;
    ok(typeName);

    const root = "root";
    const scope = new Scope();
    const rootLocal = scope.createAttribute([], root);

    const guard = predicateFunction(root, `is${typeName}`, typeName, [
      ...this.getAssertionsForLocalVar(
        scope,
        [],
        rootLocal,
        [typeName],
        type
      ),
      // ...assertAreNotNever(scope.list()),
      ...typeSafeCheckAssembly(scope, root, [root], typeName, type),
      returnTrue(),
    ]);

    this.guards.set(typeName, guard);
  }

  getGuards(): ts.Statement[] {
    return [...this.guards.values()];
  }

  getTypeImports(sourceFileName: string): ts.Statement[] {
    return [
      factory.createImportDeclaration(
        undefined,
        factory.createImportClause(
          false,
          undefined,

          factory.createNamedImports(
            [...this.guards.keys()].map((className) => {
              return factory.createImportSpecifier(
                true,
                undefined,
                factory.createIdentifier(className)
              );
            })
          )
        ),
        factory.createStringLiteral(sourceFileName),
        undefined
      ),
    ];
  }

  getFullFileBody(sourceFileName: string): ts.Statement[] {
    return [
      ...this.getTypeImports(sourceFileName),
      ...typeSafeShallowShape(),
      ...functionEnsureType(),
      ...this.getGuards(),
    ];
  }
}

function returnTrue(): ts.Statement {
  return factory.createReturnStatement(factory.createTrue());
}

const ensureType = "ensureType";

function functionEnsureType(): ts.Statement[] {
  return [
    factory.createFunctionDeclaration(
      undefined,
      undefined,
      factory.createIdentifier(ensureType),
      [
        factory.createTypeParameterDeclaration(
          undefined,
          factory.createIdentifier("T"),
          undefined,
          undefined
        ),
      ],
      [
        factory.createParameterDeclaration(
          undefined,
          undefined,
          factory.createIdentifier("_"),
          undefined,
          factory.createTypeReferenceNode(
            factory.createIdentifier("T"),
            undefined
          ),
          undefined
        ),
      ],
      undefined,
      factory.createBlock([], false)
    ),
  ];
}

const SafeShallowShape = "SafeShallowShape";

/**
 * Returns:
 * ```
 * type SafeShallowShape<Type> = {
 *  [_ in keyof Type]?: unknown;
 * };
 * ```
 */
function typeSafeShallowShape(): ts.Statement[] {
  return [
    factory.createTypeAliasDeclaration(
      undefined,
      factory.createIdentifier(SafeShallowShape),
      [
        factory.createTypeParameterDeclaration(
          undefined,
          factory.createIdentifier("Type"),
          undefined,
          undefined
        ),
      ],
      factory.createMappedTypeNode(
        undefined,
        factory.createTypeParameterDeclaration(
          undefined,
          factory.createIdentifier("_"),
          factory.createTypeOperatorNode(
            ts.SyntaxKind.KeyOfKeyword,
            factory.createTypeReferenceNode(
              factory.createIdentifier("Type"),
              undefined
            )
          ),
          undefined
        ),
        undefined,
        factory.createToken(ts.SyntaxKind.QuestionToken),
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        undefined
      )
    ),
  ];
}

function assertionConditionForType(
  target: string,
  type: TypeModel
): ts.Expression {
  if (type instanceof ReferenceType) {
    return factory.createCallExpression(
      factory.createIdentifier(`is${type.name}`),
      undefined,
      [factory.createIdentifier(target)]
    );
  }

  if (type instanceof PrimitiveType) {
    return factory.createBinaryExpression(
      factory.createTypeOfExpression(
        factory.createIdentifier(target)
      ),
      factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
      factory.createStringLiteral(type.primitive)
    );
  }

  if (type instanceof LiteralType) {
    return factory.createBinaryExpression(
      factory.createIdentifier(target),
      factory.createToken(ts.SyntaxKind.EqualsEqualsEqualsToken),
      valueToNode(type.value)
    );
  }

  if (type instanceof UnionType) {
    // A union is a set of at least two types.
    assert(type.types.length >= 2);
    // Nested unions look like an error and are not supported.
    assert(!type.types.some((t) => t instanceof UnionType));
    return wrapListInOr(
      type.types.map((t) => assertionConditionForType(target, t))
    );
  }

  if (type instanceof ObjectType) {
    throw new TypeError(`${type.constructor.name} is invalid here`);
  }

  unimplemented(`${(type as Object).constructor.name}`);
}

function ifNotReturnFalse(
  negatedCondition: ts.Expression
): ts.Statement[] {
  return [
    factory.createIfStatement(
      factory.createPrefixUnaryExpression(
        ts.SyntaxKind.ExclamationToken,
        factory.createParenthesizedExpression(negatedCondition)
      ),
      factory.createBlock(
        [factory.createReturnStatement(factory.createFalse())],
        true
      ),
      undefined
    ),
  ];
}

function or(
  left: ts.Expression,
  right: ts.Expression
): ts.Expression {
  return factory.createBinaryExpression(
    left,
    factory.createToken(ts.SyntaxKind.BarBarToken),
    right
  );
}

function wrapRestInOr(head: ts.Expression, list: ts.Expression[]) {
  if (list.length == 0) {
    return head;
  }

  const [next, ...rest] = list;
  ok(next);
  return wrapRestInOr(or(head, parens(next)), rest);
}

function wrapListInOr(list: ts.Expression[]) {
  assert(list.length >= 2);
  const [first, second, ...rest] = list;
  ok(first);
  ok(second);

  const head = or(parens(first), parens(second));
  return wrapRestInOr(head, rest);
}

function parens(e: ts.Expression): ts.Expression {
  return factory.createParenthesizedExpression(e);
}

function assertIsObject(target: string): ts.Statement[] {
  return [
    factory.createIfStatement(
      factory.createPrefixUnaryExpression(
        ts.SyntaxKind.ExclamationToken,
        factory.createParenthesizedExpression(
          factory.createBinaryExpression(
            factory.createBinaryExpression(
              factory.createTypeOfExpression(
                factory.createIdentifier(target)
              ),
              factory.createToken(
                ts.SyntaxKind.EqualsEqualsEqualsToken
              ),
              factory.createStringLiteral("object")
            ),
            factory.createToken(
              ts.SyntaxKind.AmpersandAmpersandToken
            ),
            factory.createBinaryExpression(
              factory.createIdentifier(target),
              factory.createToken(
                ts.SyntaxKind.ExclamationEqualsEqualsToken
              ),
              factory.createNull()
            )
          )
        )
      ),
      factory.createBlock(
        [factory.createReturnStatement(factory.createFalse())],
        true
      ),
      undefined
    ),
  ];
}

function objectSpread(
  target: string,
  properties: AttributeLocal[],
  type: string
): ts.Statement[] {
  ok(properties.length != 0);
  return [
    factory.createVariableStatement(
      undefined,
      factory.createVariableDeclarationList(
        [
          factory.createVariableDeclaration(
            factory.createObjectBindingPattern(
              properties.map((id) =>
                factory.createBindingElement(
                  undefined,
                  id.isShorthand()
                    ? undefined
                    : JSON.stringify(id.attribute_name),
                  id.local_name,
                  undefined
                )
              )
            ),
            undefined,
            factory.createTypeReferenceNode(
              factory.createIdentifier(SafeShallowShape),
              [
                factory.createTypeReferenceNode(
                  factory.createIdentifier(type),
                  undefined
                ),
              ]
            ),
            factory.createIdentifier(target)
          ),
        ],
        ts.NodeFlags.Const
      )
    ),
  ];
}

type LiteralValue =
  | undefined
  | null
  | string
  | number
  | boolean
  | ts.PseudoBigInt;

function valueToNode(value: LiteralValue): ts.Expression {
  if (value === null) {
    return factory.createNull();
  }
  if (value === undefined) {
    return factory.createIdentifier("undefined");
  }

  unimplemented();
}

function typePathToTypeSelector(path: string[]): string {
  const [root, ...rest] = path;
  return `${root}${rest.map((attr) => `[${JSON.stringify(attr)}]`)}`;
}

function typeSafeCheckObject(
  scope: Scope,
  path: Path,
  type: ObjectType
): ts.Expression {
  const attributes = Object.entries(type.attributes).map(
    ([attr, type]) => {
      const local = scope.getByPath(path, attr);
      const { aliasName } = type.options;
      if (!aliasName) {
        if (type instanceof ObjectType) {
          return factory.createPropertyAssignment(
            factory.createIdentifier(local.local_name),
            typeSafeCheckObject(scope, [...path, attr], type)
          );
        }
      }

      if (local.isShorthand()) {
        return factory.createShorthandPropertyAssignment(
          factory.createIdentifier(local.local_name),
          undefined
        );
      } else {
        return factory.createPropertyAssignment(
          JSON.stringify(local.attribute_name),
          factory.createIdentifier(local.local_name)
        );
      }
    }
  );

  return factory.createObjectLiteralExpression(attributes, true);
}

function typeSafeCheckAssembly(
  scope: Scope,
  target: string,
  path: Path,
  typeName: string,
  type: TypeModel
): ts.Statement[] {
  let value: ts.Expression;

  if (type instanceof ObjectType) {
    value = typeSafeCheckObject(scope, path, type);
  } else {
    value = factory.createIdentifier(target);
  }

  return [
    factory.createExpressionStatement(
      factory.createCallExpression(
        factory.createIdentifier(ensureType),
        [
          factory.createTypeReferenceNode(
            factory.createIdentifier(typeName),
            undefined
          ),
        ],
        [value]
      )
    ),
  ];
}

const is_never = "is_never";

function assertIsNotNever(target: string): ts.Statement {
  const targetID = factory.createIdentifier(target);
  ts.addSyntheticLeadingComment(
    targetID,
    ts.SyntaxKind.SingleLineCommentTrivia,
    " @ts-expect-error: should not be `never`",
    true
  );
  return factory.createExpressionStatement(
    factory.createCallExpression(
      factory.createIdentifier(is_never),
      undefined,
      [targetID]
    )
  );
}

function assertAreNotNever(targets: string[]): ts.Statement[] {
  return targets.map(assertIsNotNever);
}

function predicateFunction(
  argument: string,
  name: string,
  returnType: string,
  body: ts.Statement[]
): ts.Statement {
  return factory.createFunctionDeclaration(
    [factory.createToken(ts.SyntaxKind.ExportKeyword)],
    undefined,
    factory.createIdentifier(name),
    undefined,
    [
      factory.createParameterDeclaration(
        undefined,
        undefined,
        factory.createIdentifier(argument),
        undefined,
        factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
        undefined
      ),
    ],
    factory.createTypePredicateNode(
      undefined,
      factory.createIdentifier(argument),
      factory.createTypeReferenceNode(
        factory.createIdentifier(returnType),
        undefined
      )
    ),
    factory.createBlock(body, true)
  );
}
