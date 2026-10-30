import { CircleAlert, LoaderCircle, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Icon } from "./Icon.tsx";

export function ErrorNotice({ message, onDismiss }: { message?: string; onDismiss?: () => void }) {
  return message ? (
    <div className="notice error" role="alert">
      <Icon icon={CircleAlert} size={16} />
      <span>{message}</span>
      {onDismiss ? (
        <button type="button" className="text-button" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
    </div>
  ) : null;
}

/** A reply that failed: the same error treatment as page notices, sized to sit under a message. */
export function MessageError({ message }: { message: string }) {
  return (
    <div className="notice error message-error" role="note">
      <Icon icon={CircleAlert} size={15} />
      <span>
        <strong>Reply failed</strong>
        <span className="message-error-detail">{message}</span>
      </span>
    </div>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Icon icon={LoaderCircle} size={16} weight="control" className="spin" />
      {label}
    </div>
  );
}

export function Empty({
  title,
  icon,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  children?: ReactNode;
}) {
  return (
    <div className="empty">
      {icon ? (
        <span className="empty-icon" aria-hidden="true">
          <Icon icon={icon} size={20} />
        </span>
      ) : null}
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
