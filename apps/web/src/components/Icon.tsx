import type { LucideIcon } from "lucide-react";

/** Stroke weights tuned to the desktop app's SF Symbol weights. */
const WEIGHTS = { regular: 1.75, control: 2, send: 2.25 } as const;

export function Icon({
  icon: Glyph,
  size = 15,
  weight = "regular",
  className,
}: {
  icon: LucideIcon;
  size?: number;
  weight?: keyof typeof WEIGHTS;
  className?: string;
}) {
  return (
    <Glyph
      aria-hidden="true"
      focusable="false"
      size={size}
      strokeWidth={WEIGHTS[weight]}
      className={className}
    />
  );
}
