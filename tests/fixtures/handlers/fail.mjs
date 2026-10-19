export default {
  type: "wt:fail",
  async execute() {
    throw new Error("always fails");
  },
};
