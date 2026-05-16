import { useEffect, useRef, type ReactElement } from "react";
import styles from "./TitleBar.module.css";

export function TitleBar(): ReactElement {
  const dragRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (dragRef.current) {
      dragRef.current.style.webkitAppRegion = "drag";
    }
  }, []);

  function handleMinimize() {
    window.electronAPI.window.minimize();
  }

  function handleMaximize() {
    window.electronAPI.window.maximize();
  }

  function handleClose() {
    window.electronAPI.window.close();
  }

  return (
    <div className={styles.titleBar} data-testid="title-bar">
      <div
        ref={dragRef}
        className={styles.dragRegion}
        data-drag-region
      />
      <div className={styles.controls}>
        <button
          className={styles.controlBtn}
          data-control="minimize"
          onClick={handleMinimize}
          aria-label="Minimize"
        />
        <button
          className={styles.controlBtn}
          data-control="maximize"
          onClick={handleMaximize}
          aria-label="Maximize"
        />
        <button
          className={`${styles.controlBtn} ${styles.closeBtn}`}
          data-control="close"
          onClick={handleClose}
          aria-label="Close"
        />
      </div>
    </div>
  );
}
