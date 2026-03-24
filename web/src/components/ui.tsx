import { useEffect, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

export function UiButton({
  variant = "secondary",
  size = "md",
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return (
    <button
      {...props}
      className={`ui-button ui-${variant} ui-${size} ${className}`.trim()}
    >
      {children}
    </button>
  );
}

export function UiIconButton({
  tooltip,
  label,
  className = "",
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tooltip: string;
  label: string;
}) {
  return (
    <UiTooltip content={tooltip}>
      <button
        {...props}
        aria-label={label}
        className={`ui-icon-button ${className}`.trim()}
      >
        {children}
      </button>
    </UiTooltip>
  );
}

export function UiInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`ui-input ${props.className || ""}`.trim()} />;
}

export function UiSelect(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`ui-select ${props.className || ""}`.trim()} />;
}

export function UiTooltip({
  content,
  children,
  className = ""
}: {
  content: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={`ui-tooltip ${className}`.trim()} data-tooltip={content}>
      {children}
    </span>
  );
}

export function UiBadge({
  tone = "neutral",
  children,
  className = ""
}: {
  tone?: "neutral" | "accent" | "success" | "warning" | "danger";
  children: ReactNode;
  className?: string;
}) {
  return <span className={`ui-badge ui-badge-${tone} ${className}`.trim()}>{children}</span>;
}

export function UiDialog({
  open,
  title,
  description,
  onClose,
  children,
  actions
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [onClose, open]);
  if (!open) return null;
  return (
    <div className="ui-dialog-overlay" role="presentation" onClick={onClose}>
      <div
        className="ui-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ui-dialog-header">
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
        <div className="ui-dialog-body">{children}</div>
        {actions && <div className="ui-dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

export function UiCard(props: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`ui-card ${props.className || ""}`.trim()} />;
}

