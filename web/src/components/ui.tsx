import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes
} from "react";
import { createPortal } from "react-dom";

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

function UiTooltip({
  content,
  children,
  className = ""
}: {
  content: string;
  children: ReactNode;
  className?: string;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [visible, setVisible] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  const updatePosition = () => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPosition({
      left: rect.left + rect.width / 2,
      top: Math.max(8, rect.top - 8)
    });
  };

  useEffect(() => {
    if (!visible) return;
    updatePosition();
    const onLayout = () => updatePosition();
    window.addEventListener("scroll", onLayout, true);
    window.addEventListener("resize", onLayout);
    return () => {
      window.removeEventListener("scroll", onLayout, true);
      window.removeEventListener("resize", onLayout);
    };
  }, [visible]);

  return (
    <span
      ref={anchorRef}
      className={`ui-tooltip ${className}`.trim()}
      onMouseEnter={() => {
        updatePosition();
        setVisible(true);
      }}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => {
        updatePosition();
        setVisible(true);
      }}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible &&
        typeof document !== "undefined" &&
        createPortal(
          <span
            className="ui-tooltip-popup"
            style={{
              left: `${position.left}px`,
              top: `${position.top}px`
            }}
          >
            {content}
          </span>,
          document.body
        )}
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
