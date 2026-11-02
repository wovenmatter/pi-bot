import type { LucideIcon } from "lucide-react";

/** DashboardLucideGlyph vector stroke widths (regular, control, send). */
const WEIGHTS = { regular: 1.5, control: 1.75, send: 2.5 } as const;

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
