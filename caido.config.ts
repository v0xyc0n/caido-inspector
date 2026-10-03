import { defineConfig } from "@caido-community/dev";

export default defineConfig({
  id: "inspector",
  name: "Inspector",
  description: "Save interesting requests to a persistent list for later review.",
  version: "1.1.0",
  author: {
    name: "Jakob Pachmann",
    email: "jakob.pachmann@proton.me",
  },
  plugins: [
    {
      kind: "frontend",
      id: "inspector-frontend",
      root: "plugin",
    },
  ],
});
