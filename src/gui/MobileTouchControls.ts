let mobileTouchButton: number = 0;

/** Normalized joystick direction in [-1, 1]. Called while the stick is active. */
export type MobileJoystickPanHandler = (nx: number, ny: number) => void;

let joystickPanHandler: MobileJoystickPanHandler | undefined;
let controlsVisible = false;
let controlsRoot: HTMLElement | undefined;
/** Force-release active joystick (e.g. when HUD hides mid-drag). */
let forceReleaseJoystick: (() => void) | undefined;

export function getMobileTouchButton(): number {
  return mobileTouchButton;
}

export function setMobileTouchButton(button: number): void {
  mobileTouchButton = button;
}

export function setMobileJoystickPanHandler(handler?: MobileJoystickPanHandler): void {
  joystickPanHandler = handler;
}

/** Show only during an active match (hidden in menus / loading). */
export function setMobileTouchControlsVisible(visible: boolean): void {
  controlsVisible = visible;
  if (controlsRoot) {
    controlsRoot.classList.toggle('mobile-touch-controls-visible', visible);
  }
  if (!visible) {
    mobileTouchButton = 0;
    // Finger may still be down when match UI hides — always spring the stick back.
    forceReleaseJoystick?.();
  }
}

export function createMobileTouchControls(container: HTMLElement): () => void {
  const wrapper = document.createElement('div');
  wrapper.className = 'mobile-touch-controls';
  controlsRoot = wrapper;
  wrapper.classList.toggle('mobile-touch-controls-visible', controlsVisible);

  const cluster = document.createElement('div');
  cluster.className = 'mobile-touch-cluster';

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'mobile-touch-buttons-row';

  const rightBtn = document.createElement('button');
  rightBtn.type = 'button';
  rightBtn.className = 'mobile-touch-btn mobile-touch-btn-right';
  rightBtn.textContent = 'R';
  rightBtn.setAttribute('aria-label', 'Hold for right click');

  const joystick = document.createElement('div');
  joystick.className = 'mobile-joystick';
  joystick.setAttribute('aria-label', 'Camera pan joystick');

  const knob = document.createElement('div');
  knob.className = 'mobile-joystick-knob';
  joystick.appendChild(knob);

  buttonsRow.appendChild(rightBtn);
  cluster.appendChild(buttonsRow);
  cluster.appendChild(joystick);
  wrapper.appendChild(cluster);
  container.appendChild(wrapper);

  mobileTouchButton = 0;

  const JOYSTICK_RADIUS = 42;
  const DEADZONE = 0.12;
  let joystickPointerId: number | undefined;
  let joystickCenter = { x: 0, y: 0 };
  let stickNx = 0;
  let stickNy = 0;
  let panRaf = 0;

  let rightHoldPointerId: number | undefined;

  const setKnob = (nx: number, ny: number): void => {
    const px = nx * JOYSTICK_RADIUS;
    const py = ny * JOYSTICK_RADIUS;
    knob.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px))`;
  };

  const resetKnob = (): void => {
    stickNx = 0;
    stickNy = 0;
    setKnob(0, 0);
    joystick.classList.remove('active');
  };

  const stopPanLoop = (): void => {
    if (panRaf) {
      cancelAnimationFrame(panRaf);
      panRaf = 0;
    }
  };

  const panLoop = (): void => {
    if (stickNx || stickNy) {
      joystickPanHandler?.(stickNx, stickNy);
      panRaf = requestAnimationFrame(panLoop);
    } else {
      panRaf = 0;
    }
  };

  const startPanLoop = (): void => {
    if (!panRaf) {
      panRaf = requestAnimationFrame(panLoop);
    }
  };

  const updateStickFromPoint = (clientX: number, clientY: number): void => {
    const dx = clientX - joystickCenter.x;
    const dy = clientY - joystickCenter.y;
    const dist = Math.hypot(dx, dy);
    const max = JOYSTICK_RADIUS;
    const clamped = dist > max && dist > 0 ? max / dist : 1;
    const cx = dx * clamped;
    const cy = dy * clamped;
    let nx = cx / max;
    let ny = cy / max;
    const mag = Math.hypot(nx, ny);
    if (mag < DEADZONE) {
      nx = 0;
      ny = 0;
    } else {
      const scale = (mag - DEADZONE) / (1 - DEADZONE);
      nx = (nx / mag) * scale;
      ny = (ny / mag) * scale;
    }
    stickNx = nx;
    stickNy = ny;
    setKnob(nx, ny);
    if (nx || ny) {
      startPanLoop();
    }
  };

  const endJoystick = (pointerId: number): void => {
    if (joystickPointerId !== pointerId) {
      return;
    }
    joystickPointerId = undefined;
    window.removeEventListener('pointerup', onJoystickWindowUp, true);
    window.removeEventListener('pointercancel', onJoystickWindowUp, true);
    window.removeEventListener('blur', onWindowBlur);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('touchend', onTouchEndOrCancel, true);
    window.removeEventListener('touchcancel', onTouchEndOrCancel, true);
    joystick.removeEventListener('lostpointercapture', onJoystickLostCapture);
    try {
      joystick.releasePointerCapture?.(pointerId);
    } catch {
      // ignore — may already be released
    }
    resetKnob();
    stopPanLoop();
  };

  const onJoystickWindowUp = (e: PointerEvent): void => {
    endJoystick(e.pointerId);
  };

  const onJoystickLostCapture = (e: PointerEvent): void => {
    // Capture can drop without a clean pointerup on some mobile browsers.
    endJoystick(e.pointerId);
  };

  const releaseActiveJoystick = (): void => {
    if (joystickPointerId !== undefined) {
      endJoystick(joystickPointerId);
    } else {
      resetKnob();
      stopPanLoop();
    }
  };

  const onWindowBlur = (): void => {
    releaseActiveJoystick();
  };

  const onVisibilityChange = (): void => {
    if (document.hidden) {
      releaseActiveJoystick();
    }
  };

  /** Failsafe when pointerup is dropped but touchend still fires (all fingers up). */
  const onTouchEndOrCancel = (_e: TouchEvent): void => {
    if (joystickPointerId === undefined) {
      return;
    }
    if (_e.touches.length === 0) {
      releaseActiveJoystick();
    }
  };

  forceReleaseJoystick = releaseActiveJoystick;

  const onJoystickPointerDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    // Previous drag stuck? Clear it so a new touch can take over.
    if (joystickPointerId !== undefined) {
      endJoystick(joystickPointerId);
    }
    joystickPointerId = e.pointerId;
    try {
      joystick.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture optional; window capture-phase listeners still release correctly.
    }
    const rect = joystick.getBoundingClientRect();
    joystickCenter = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    joystick.classList.add('active');
    // Capture phase: still receive release if game canvas stopsPropagation on bubble.
    window.addEventListener('pointerup', onJoystickWindowUp, true);
    window.addEventListener('pointercancel', onJoystickWindowUp, true);
    window.addEventListener('touchend', onTouchEndOrCancel, true);
    window.addEventListener('touchcancel', onTouchEndOrCancel, true);
    window.addEventListener('blur', onWindowBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    joystick.addEventListener('lostpointercapture', onJoystickLostCapture);
    updateStickFromPoint(e.clientX, e.clientY);
  };

  const onJoystickPointerMove = (e: PointerEvent): void => {
    if (joystickPointerId !== e.pointerId) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    updateStickFromPoint(e.clientX, e.clientY);
  };

  // Also listen on window for move so drag stays smooth if capture is flaky.
  const onJoystickWindowMove = (e: PointerEvent): void => {
    if (joystickPointerId !== e.pointerId) {
      return;
    }
    e.preventDefault();
    updateStickFromPoint(e.clientX, e.clientY);
  };

  const endRightHold = (pointerId: number): void => {
    if (rightHoldPointerId !== pointerId) {
      return;
    }
    rightHoldPointerId = undefined;
    mobileTouchButton = 0;
    rightBtn.classList.remove('active');
    window.removeEventListener('pointerup', onRightWindowUp);
    window.removeEventListener('pointercancel', onRightWindowUp);
  };

  const onRightWindowUp = (e: PointerEvent): void => {
    endRightHold(e.pointerId);
  };

  const onRightDown = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    rightHoldPointerId = e.pointerId;
    mobileTouchButton = 2;
    rightBtn.classList.add('active');
    window.addEventListener('pointerup', onRightWindowUp);
    window.addEventListener('pointercancel', onRightWindowUp);
  };

  rightBtn.addEventListener('pointerdown', onRightDown);

  joystick.addEventListener('pointerdown', onJoystickPointerDown);
  joystick.addEventListener('pointermove', onJoystickPointerMove);
  window.addEventListener('pointermove', onJoystickWindowMove, { passive: false });

  const blockTouch = (e: Event): void => {
    e.preventDefault();
    e.stopPropagation();
  };
  cluster.addEventListener('touchstart', blockTouch, { passive: false });
  cluster.addEventListener('touchmove', blockTouch, { passive: false });

  return () => {
    forceReleaseJoystick = undefined;
    releaseActiveJoystick();
    if (rightHoldPointerId !== undefined) {
      endRightHold(rightHoldPointerId);
    }
    mobileTouchButton = 0;
    joystickPanHandler = undefined;
    if (controlsRoot === wrapper) {
      controlsRoot = undefined;
    }

    rightBtn.removeEventListener('pointerdown', onRightDown);

    joystick.removeEventListener('pointerdown', onJoystickPointerDown);
    joystick.removeEventListener('pointermove', onJoystickPointerMove);
    window.removeEventListener('pointermove', onJoystickWindowMove);

    cluster.removeEventListener('touchstart', blockTouch);
    cluster.removeEventListener('touchmove', blockTouch);
    wrapper.remove();
  };
}
