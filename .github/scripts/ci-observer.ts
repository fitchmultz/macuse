import { writeFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { getPackageDir, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI): void {
  // Answers the validator's prompt locally; no model request leaves the machine.
  const faux = fauxProvider({ provider: "macuse-ci", models: [{ id: "native" }] });
  faux.setResponses([fauxAssistantMessage("ok")]);
  pi.registerProvider(faux.provider);
  pi.on("before_agent_start", () => {
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
  });
  pi.on("agent_settled", (_event, ctx) => ctx.shutdown());
}
