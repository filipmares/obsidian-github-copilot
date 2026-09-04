"use strict";

module.exports = {
  CopilotClient: class CopilotClient {},
  RuntimeConnection: {
    forStdio: (options = {}) => ({ kind: "stdio", ...options }),
  },
};
