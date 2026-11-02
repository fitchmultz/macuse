import { writeFileSync } from "node:fs";
import { getPackageDir, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  pi.registerCommand("macuse-ci-probe", {
    description: "Inspect extension registration without starting a model turn",
    handler: async (_args, ctx) => {
      const observationPath = process.env.MACUSE_CI_OBSERVATION;
      if (observationPath === undefined || observationPath === "") {
        throw new Error("MACUSE_CI_OBSERVATION must specify an output path.");
      }
      writeFileSync(
        observationPath,
        JSON.stringify({
          packageDir: getPackageDir(),
          version: VERSION,
          tools: pi.getAllTools().map(({ name }) => name),
          activeTools: pi.getActiveTools(),
          commands: pi.getCommands().map(({ name }) => name),
        }),
      );
      ctx.shutdown();
    },
  });
}
