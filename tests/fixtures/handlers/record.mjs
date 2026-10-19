export default {
  type: "wt:record",
  async execute(ev, ctx) {
    await ctx.redis.rPush(`${ctx.stream}:seen`, ev.n);
  },
};
