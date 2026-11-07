export function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
    render: (_a, value) => [{ type: 'text', text: String(value.text) }],
  };
}