import piLogo from "../assets/pi-logo.svg";

/**
 * Pi's colour mark on its circular black badge, as WovenMatter shows it (the badge is part of the
 * image, so it reads the same on every theme). Decorative: the "Pi Bot" text names the app.
 */
export function PiLogo({ className }: { className?: string }) {
  return (
    <img
      className={className ? `brand-mark ${className}` : "brand-mark"}
      src={piLogo}
      alt=""
      aria-hidden="true"
    />
  );
}

export function Brand() {
  return (
    <a href="#/" className="brand">
      <PiLogo />
      <span>Pi Bot</span>
    </a>
  );
}
