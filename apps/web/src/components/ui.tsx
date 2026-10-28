import { CircleAlert, LoaderCircle } from "lucide-react";
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

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="loading" role="status">
      <Icon icon={LoaderCircle} size={16} weight="control" className="spin" />
      {label}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
    </div>
  );
}
