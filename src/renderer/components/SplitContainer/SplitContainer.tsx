import { type ReactElement, type ReactNode, useCallback, useRef } from "react";
import type { LayoutNode } from "../../store/layout-slice";
import styles from "./SplitContainer.module.css";

const GUTTER_PX = 6;

interface SplitContainerProps {
  node: LayoutNode;
  renderLeaf: (paneId: string) => ReactNode;
  onRatioChange?: (ratio: number) => void;
}

export function SplitContainer({
  node,
  renderLeaf,
  onRatioChange,
}: SplitContainerProps): ReactElement | null {
  if (node.type === "leaf") {
    return <div className={styles.leaf}>{renderLeaf(node.paneId)}</div>;
  }

  if (node.type === "split") {
    return <SplitNode node={node} renderLeaf={renderLeaf} onRatioChange={onRatioChange} />;
  }

  // invalid node fallback
  return null;
}

// ──────────────────────────────────────────────────────────────
// Internal SplitNode — handles a single split level
// ──────────────────────────────────────────────────────────────

interface SplitNodeProps {
  node: Extract<LayoutNode, { type: "split" }>;
  renderLeaf: (paneId: string) => ReactNode;
  onRatioChange?: (ratio: number) => void;
}

function SplitNode({ node, renderLeaf, onRatioChange }: SplitNodeProps): ReactElement {
  const { direction, children, ratio } = node;
  const containerRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);

  const pct0 = Math.round(ratio * 100);
  const pct1 = 100 - pct0;

  const gridStyle: React.CSSProperties =
    direction === "horizontal"
      ? { gridTemplateColumns: `${pct0}fr ${GUTTER_PX}px ${pct1}fr` }
      : { gridTemplateRows: `${pct0}fr ${GUTTER_PX}px ${pct1}fr` };

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;

      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const el = containerRef.current;
        if (!el || !onRatioChange) return;

        const rect = el.getBoundingClientRect();
        let newRatio: number;
        if (direction === "horizontal") {
          newRatio = (ev.clientX - rect.left) / rect.width;
        } else {
          newRatio = (ev.clientY - rect.top) / rect.height;
        }
        newRatio = Math.max(0.05, Math.min(0.95, newRatio));
        onRatioChange(newRatio);
      };

      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [direction, onRatioChange]
  );

  const handleDoubleClick = useCallback(() => {
    onRatioChange?.(0.5);
  }, [onRatioChange]);

  return (
    <div
      ref={containerRef}
      className={styles.split}
      data-split-direction={direction}
      style={gridStyle}
    >
      <SplitContainer node={children[0]} renderLeaf={renderLeaf} onRatioChange={onRatioChange} />
      <div
        className={styles.gutter}
        data-gutter
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
      />
      <SplitContainer node={children[1]} renderLeaf={renderLeaf} onRatioChange={onRatioChange} />
    </div>
  );
}
