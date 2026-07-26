let mobileTouchButton: number = 0;
let mobileTouchCtrlHeld = false;

/** Normalized joystick direction in [-1, 1]. Called while the stick is active. */
export type MobileJoystickPanHandler = (nx: number, ny: number) => void;

/** Fired when mobile modifier hold state changes (e.g. Ctrl for force-attack). */
export type MobileModifierChangeHandler = (mods: {
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}) => void;

let joystickPanHandler: MobileJoystickPanHandler | undefined;
let modifierChangeHandler: MobileModifierChangeHandler | undefined;
let controlsVisible = false;
let controlsRoot: HTMLElement | undefined;
/** Force-release active joystick (e.g. when HUD hides mid-drag). */
let forceReleaseJoystick: (() => void) | undefined;
/** Force-release R-hold so canvas touches stop looking like RMB. */
let forceReleaseRightHold: (() => void) | undefined;
/** Force-release Ctrl-hold so force-attack doesn't stick. */
let forceReleaseCtrlHold: (() => void) | undefined;

export function getMobileTouchButton(): number {
  return mobileTouchButton;
}

export function setMobileTouchButton(button: number): void {
  mobileTouchButton = button;
}

/** True while the on-screen Ctl button is held (maps to keyboard Ctrl). */
export function getMobileTouchCtrl(): boolean {
  return mobileTouchCtrlHeld;
}

export function setMobileJoystickPanHandler(handler?: MobileJoystickPanHandler): void {
  joystickPanHandler = handler;
}

export function setMobileModifierChangeHandler(handler?: MobileModifierChangeHandler): void {
  modifierChangeHandler = handler;
}

function notifyModifierChange(): void {
  modifierChangeHandler?.({
    ctrlKey: mobileTouchCtrlHeld,
    shiftKey: false,
    altKey: false,
  });
}

/** Show only during an active match (hidden in menus / loading). */
export function setMobileTouchControlsVisible(visible: boolean): void {
  controlsVisible = visible;
  if (controlsRoot) {
    controlsRoot.classList.toggle('mobile-touch-controls-visible', visible);
  }
  if (!visible) {
    // Finger may still be down when match UI hides — clear stick + holds.
    forceReleaseJoystick?.();
    forceReleaseRightHold?.();
    forceReleaseCtrlHold?.();
    mobileTouchButton = 0;
    mobileTouchCtrlHeld = false;
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

  const ctrlBtn = document.createElement('button');
  ctrlBtn.type = 'button';
  ctrlBtn.className = 'mobile-touch-btn mobile-touch-btn-ctrl';
  ctrlBtn.textContent = 'Ctl';
  ctrlBtn.setAttribute('aria-label', 'Hold for Ctrl (force attack)');

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

  buttonsRow.appendChild(ctrlBtn);
  buttonsRow.appendChild(rightBtn);
  cluster.appendChild(buttonsRow);
  cluster.appendChild(joystick);
  wrapper.appendChild(cluster);
  container.appendChild(wrapper);

  mobileTouchButton = 0;
  mobileTouchCtrlHeld = false;

  const JOYSTICK_RADIUS = 42;
  const DEADZONE = 0.12;
  let joystickPointerId: number | undefined;
  let joystickCenter = { x: 0, y: 0 };
  let stickNx = 0;
  let stickNy = 0;
  let panRaf = 0;

  let rightHoldPointerId: number | undefined;
  let ctrlHoldPointerId: number | undefined;

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

  type HoldCleanup = {
    removeListeners: () => void;
    end: (pointerId: number) => void;
    release: () => void;
    onDown: (e: PointerEvent) => void;
  };

  const createHoldControl = (opts: {
    button: HTMLButtonElement;
    onActiveChange: (active: boolean) => void;
    getPointerId: () => number | undefined;
    setPointerId: (id: number | undefined) => void;
  }): HoldCleanup => {
    const removeListeners = (): void => {
      window.removeEventListener('pointerup', onWindowUp, true);
      window.removeEventListener('pointercancel', onWindowUp, true);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('touchend', onTouchFailsafe, true);
      window.removeEventListener('touchcancel', onTouchFailsafe, true);
      opts.button.removeEventListener('lostpointercapture', onLostCapture);
    };

    const end = (pointerId: number): void => {
      if (opts.getPointerId() !== pointerId) {
        return;
      }
      opts.setPointerId(undefined);
      opts.onActiveChange(false);
      opts.button.classList.remove('active');
      removeListeners();
      try {
        opts.button.releasePointerCapture?.(pointerId);
      } catch {
        // ignore
      }
    };

    const release = (): void => {
      const id = opts.getPointerId();
      if (id !== undefined) {
        end(id);
      } else {
        opts.onActiveChange(false);
        opts.button.classList.remove('active');
        removeListeners();
      }
    };

    const onWindowUp = (e: PointerEvent): void => {
      end(e.pointerId);
    };
    const onLostCapture = (e: PointerEvent): void => {
      end(e.pointerId);
    };
    const onBlur = (): void => {
      release();
    };
    const onVis = (): void => {
      if (document.hidden) {
        release();
      }
    };
    const onTouchFailsafe = (e: TouchEvent): void => {
      if (opts.getPointerId() === undefined) {
        return;
      }
      if (e.touches.length === 0) {
        release();
      }
    };

    const onDown = (e: PointerEvent): void => {
      e.preventDefault();
      e.stopPropagation();
      if (opts.getPointerId() !== undefined) {
        end(opts.getPointerId()!);
      }
      opts.setPointerId(e.pointerId);
      opts.onActiveChange(true);
      opts.button.classList.add('active');
      try {
        opts.button.setPointerCapture?.(e.pointerId);
      } catch {
        // optional
      }
      window.addEventListener('pointerup', onWindowUp, true);
      window.addEventListener('pointercancel', onWindowUp, true);
      window.addEventListener('touchend', onTouchFailsafe, true);
      window.addEventListener('touchcancel', onTouchFailsafe, true);
      window.addEventListener('blur', onBlur);
      document.addEventListener('visibilitychange', onVis);
      opts.button.addEventListener('lostpointercapture', onLostCapture);
    };

    return { removeListeners, end, release, onDown };
  };

  const rightHold = createHoldControl({
    button: rightBtn,
    getPointerId: () => rightHoldPointerId,
    setPointerId: (id) => {
      rightHoldPointerId = id;
    },
    onActiveChange: (active) => {
      mobileTouchButton = active ? 2 : 0;
    },
  });
  forceReleaseRightHold = rightHold.release;

  const ctrlHold = createHoldControl({
    button: ctrlBtn,
    getPointerId: () => ctrlHoldPointerId,
    setPointerId: (id) => {
      ctrlHoldPointerId = id;
    },
    onActiveChange: (active) => {
      mobileTouchCtrlHeld = active;
      notifyModifierChange();
    },
  });
  forceReleaseCtrlHold = ctrlHold.release;

  rightBtn.addEventListener('pointerdown', rightHold.onDown);
  ctrlBtn.addEventListener('pointerdown', ctrlHold.onDown);

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
    forceReleaseRightHold = undefined;
    forceReleaseCtrlHold = undefined;
    releaseActiveJoystick();
    rightHold.release();
    ctrlHold.release();
    mobileTouchButton = 0;
    mobileTouchCtrlHeld = false;
    joystickPanHandler = undefined;
    modifierChangeHandler = undefined;
    if (controlsRoot === wrapper) {
      controlsRoot = undefined;
    }

    rightBtn.removeEventListener('pointerdown', rightHold.onDown);
    ctrlBtn.removeEventListener('pointerdown', ctrlHold.onDown);

    joystick.removeEventListener('pointerdown', onJoystickPointerDown);
    joystick.removeEventListener('pointermove', onJoystickPointerMove);
    window.removeEventListener('pointermove', onJoystickWindowMove);

    cluster.removeEventListener('touchstart', blockTouch);
    cluster.removeEventListener('touchmove', blockTouch);
    wrapper.remove();
  };
}
