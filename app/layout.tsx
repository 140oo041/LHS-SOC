import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Atlas · Coral SoC", template: "%s · Atlas" },
  description: "Evidence-linked architecture, explanations, tasks, and documents for the Coral SoC.",
  icons: { icon: "/logo.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <template
          data-atlas-contract="ed7718f6"
          dangerouslySetInnerHTML={{
            __html: `<!--
THESIS: Atlas keeps the engineering artifact dominant while a persistent field log carries evidence, questions, ownership, and work; it refuses the generic dashboard of interchangeable cards.
OWN-WORLD: Bright lab drafting paper, ink-black structural rails, protocol color as status, ruled panels, compact engraved controls, and Ubuntu Sans.
STORY: Enter the Coral workspace, inspect a source-linked artifact, ask from its exact context, then move the resulting uncertainty into owned work or evidence.
FIRST VIEWPORT: A slim black instrument rail and workspace bar frame one dominant artifact; its contextual actions stay attached at the right edge instead of sending the engineer to a dashboard.
FORM: Contextual workbench plus field log, grounded candidate 3, seed ed7718f6.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
