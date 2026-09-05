export const openapiAstSchemas = {
  TypedValue: {
    type: "object",
    required: ["type", "value"],
    discriminator: { propertyName: "type" },
    description: "Values remain values; never interchangeable with identifiers. Null only via the null predicate.",
    oneOf: [
      {
        type: "object",
        required: ["type", "value"],
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["string"] },
          value: { type: "string" },
        },
      },
      {
        type: "object",
        required: ["type", "value"],
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["number"] },
          value: { type: "number" },
        },
      },
      {
        type: "object",
        required: ["type", "value"],
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["boolean"] },
          value: { type: "boolean" },
        },
      },
      {
        type: "object",
        required: ["type", "value"],
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["date"] },
          value: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", example: "2026-09-25" },
        },
      },
      {
        type: "object",
        required: ["type", "value"],
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["datetime"] },
          value: {
            type: "string",
            format: "date-time",
            example: "2026-09-25T15:30:00+05:30",
            description: "RFC 3339 with offset/Z.",
          },
        },
      },
      {
        type: "object",
        required: ["type", "value"],
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: ["uuid"] },
          value: { type: "string", format: "uuid" },
        },
      },
    ],
  },
  AggregateExpr: {
    type: "object",
    required: ["kind", "function"],
    additionalProperties: false,
    description: "field omitted only for COUNT(*).",
    properties: {
      kind: { type: "string", enum: ["aggregate"] },
      function: { type: "string", enum: ["COUNT", "COUNT_DISTINCT", "MIN", "MAX", "SUM", "AVG"] },
      field: { $ref: "#/components/schemas/FieldRef" },
    },
  },
  Predicate: {
    type: "object",
    required: ["kind"],
    discriminator: { propertyName: "kind" },
    description:
      "where and having share this language, but aggregate operands are legal only in having/aggregate ordering.",
    oneOf: [
      { $ref: "#/components/schemas/ComparisonPredicate" },
      { $ref: "#/components/schemas/TextPredicate" },
      { $ref: "#/components/schemas/SetPredicate" },
      { $ref: "#/components/schemas/NullPredicate" },
      { $ref: "#/components/schemas/BetweenPredicate" },
      { $ref: "#/components/schemas/RelativeDatePredicate" },
      { $ref: "#/components/schemas/BooleanPredicate" },
      { $ref: "#/components/schemas/NotPredicate" },
    ],
  },
  ComparisonPredicate: {
    type: "object",
    required: ["kind", "left", "operator", "right"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["comparison"] },
      left: {
        oneOf: [
          { $ref: "#/components/schemas/FieldRef" },
          { $ref: "#/components/schemas/AggregateExpr" },
        ],
        description: "Aggregate left side legal only in having/aggregate ordering.",
      },
      operator: { type: "string", enum: ["EQ", "NE", "GT", "GTE", "LT", "LTE"] },
      right: { $ref: "#/components/schemas/TypedValue" },
    },
  },
  TextPredicate: {
    type: "object",
    required: ["kind", "field", "operator", "value"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["text"] },
      field: { $ref: "#/components/schemas/FieldRef" },
      operator: { type: "string", enum: ["CONTAINS", "STARTS_WITH", "ENDS_WITH"] },
      value: { type: "string", minLength: 1 },
      caseSensitive: { type: "boolean" },
    },
  },
  SetPredicate: {
    type: "object",
    required: ["kind", "field", "operator", "values"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["set"] },
      field: { $ref: "#/components/schemas/FieldRef" },
      operator: { type: "string", enum: ["IN", "NOT_IN"] },
      values: {
        type: "array",
        minItems: 1,
        maxItems: 100,
        items: { $ref: "#/components/schemas/TypedValue" },
      },
    },
  },
  NullPredicate: {
    type: "object",
    required: ["kind", "field", "operator"],
    additionalProperties: false,
    description: "Only representation of null; never a comparison value.",
    properties: {
      kind: { type: "string", enum: ["null"] },
      field: { $ref: "#/components/schemas/FieldRef" },
      operator: { type: "string", enum: ["IS_NULL", "IS_NOT_NULL"] },
    },
  },
  BetweenPredicate: {
    type: "object",
    required: ["kind", "field", "lower", "upper", "lowerInclusive", "upperInclusive"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["between"] },
      field: { $ref: "#/components/schemas/FieldRef" },
      lower: { $ref: "#/components/schemas/TypedValue" },
      upper: { $ref: "#/components/schemas/TypedValue" },
      lowerInclusive: { type: "boolean" },
      upperInclusive: { type: "boolean" },
    },
  },
  RelativeDatePredicate: {
    type: "object",
    required: ["kind", "field", "operator", "unit"],
    additionalProperties: false,
    description:
      "Explicit calendar semantics resolved by App Engine using time_context into start-inclusive/end-exclusive UTC timestamps.",
    properties: {
      kind: { type: "string", enum: ["relativeDate"] },
      field: { $ref: "#/components/schemas/FieldRef" },
      operator: { type: "string", enum: ["IN_LAST", "IN_NEXT", "THIS", "PREVIOUS", "NEXT"] },
      amount: {
        type: "integer",
        minimum: 1,
        example: 30,
        description: "Required for IN_LAST/IN_NEXT; omitted for THIS/PREVIOUS/NEXT.",
      },
      unit: { type: "string", enum: ["DAY", "WEEK", "MONTH", "QUARTER", "YEAR"] },
    },
  },
  BooleanPredicate: {
    type: "object",
    required: ["kind", "operator", "children"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["boolean"] },
      operator: { type: "string", enum: ["AND", "OR"] },
      children: {
        type: "array",
        minItems: 2,
        maxItems: 40,
        items: { $ref: "#/components/schemas/Predicate" },
      },
    },
  },
  NotPredicate: {
    type: "object",
    required: ["kind", "child"],
    additionalProperties: false,
    properties: {
      kind: { type: "string", enum: ["not"] },
      child: { $ref: "#/components/schemas/Predicate" },
    },
  },
  OrderItem: {
    type: "object",
    required: ["expression", "direction"],
    additionalProperties: false,
    properties: {
      expression: {
        oneOf: [
          { $ref: "#/components/schemas/FieldRef" },
          { $ref: "#/components/schemas/AggregateExpr" },
        ],
      },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      nulls: { type: "string", enum: ["FIRST", "LAST"] },
    },
  },
  QueryAstV2: {
    type: "object",
    required: ["version", "root", "projection"],
    additionalProperties: false,
    description:
      "Strict AST v2. Limits: joins 4, predicate nodes 40, Boolean depth 6, group fields 8, order items 4, limit 1–1000.",
    properties: {
      version: { type: "string", enum: ["2.0"], example: "2.0" },
      root: { $ref: "#/components/schemas/EntityRef" },
      projection: { $ref: "#/components/schemas/Projection" },
      joins: {
        type: "array",
        maxItems: 4,
        items: { $ref: "#/components/schemas/Join" },
      },
      where: { $ref: "#/components/schemas/Predicate" },
      groupBy: {
        type: "array",
        maxItems: 8,
        items: { $ref: "#/components/schemas/FieldRef" },
      },
      having: {
        $ref: "#/components/schemas/Predicate",
        description: "Aggregate operands legal here (first-class HAVING).",
      },
      orderBy: {
        type: "array",
        maxItems: 4,
        items: { $ref: "#/components/schemas/OrderItem" },
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 1000,
        description: "Allowed only with deterministic orderBy.",
      },
    },
  },
};
