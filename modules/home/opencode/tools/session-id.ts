export default {
  description:
    "Returns the current session ID. Use this to create session-scoped memory keys for mcp_memory, ensuring context persists across compaction without overwriting other sessions.",
  args: {},
  async execute(_args, ctx) {
    return ctx.sessionID;
  },
};
