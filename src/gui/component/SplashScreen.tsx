import React, { useEffect, useRef, useState, MutableRefObject } from 'react';
export interface SplashScreenProps {
    width: number;
    height: number;
    parentElement: HTMLElement | null;
    backgroundImage?: string;
    loadingText?: string;
    /** 0–100; when set, shows a progress bar under the loading text. */
    progress?: number;
    copyrightText?: string;
    disclaimerText?: string;
    onRender?: () => void;
}
const SplashScreen: React.FC<SplashScreenProps> = ({
    width,
    height,
    parentElement,
    backgroundImage,
    loadingText,
    progress,
    copyrightText,
    disclaimerText,
    onRender,
}) => {
    const [rendered, setRendered] = useState(false);
    const elRef = useRef<HTMLDivElement | null>(null) as MutableRefObject<HTMLDivElement | null>;
    const panelRef = useRef<HTMLDivElement | null>(null) as MutableRefObject<HTMLDivElement | null>;
    const loadingElRef = useRef<HTMLDivElement | null>(null) as MutableRefObject<HTMLDivElement | null>;
    const barTrackRef = useRef<HTMLDivElement | null>(null) as MutableRefObject<HTMLDivElement | null>;
    const barFillRef = useRef<HTMLDivElement | null>(null) as MutableRefObject<HTMLDivElement | null>;
    const percentElRef = useRef<HTMLDivElement | null>(null) as MutableRefObject<HTMLDivElement | null>;
    const copyrightElRef = useRef<HTMLDivElement | null>(null) as MutableRefObject<HTMLDivElement | null>;
    const disclaimerElRef = useRef<HTMLDivElement | null>(null) as MutableRefObject<HTMLDivElement | null>;
    useEffect(() => {
        if (parentElement && !rendered) {
            const div = document.createElement('div');
            elRef.current = div;
            div.style.backgroundColor = '#0a0000';
            div.style.backgroundImage = 'radial-gradient(ellipse at 50% 35%, #3a0a0a 0%, #0a0000 70%)';
            div.style.color = '#f0e6d2';
            div.style.padding = '10px';
            div.style.boxSizing = 'border-box';
            div.style.backgroundRepeat = 'no-repeat';
            div.style.backgroundPosition = '50% 50%';
            div.style.backgroundSize = 'cover';
            div.style.textShadow = '1px 1px 2px rgba(0,0,0,0.9)';
            div.style.position = 'relative';
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.justifyContent = 'center';
            div.style.fontFamily = 'inherit';

            const panel = document.createElement('div');
            panelRef.current = panel;
            panel.style.width = 'min(520px, 86%)';
            panel.style.padding = '22px 24px 20px';
            panel.style.boxSizing = 'border-box';
            panel.style.border = '1px solid rgba(255, 60, 60, 0.55)';
            panel.style.background = 'rgba(0, 0, 0, 0.55)';
            panel.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.4), 0 12px 40px rgba(0,0,0,0.45)';
            div.appendChild(panel);

            const loadingDiv = document.createElement('div');
            loadingElRef.current = loadingDiv;
            loadingDiv.style.fontSize = '18px';
            loadingDiv.style.lineHeight = '1.45';
            loadingDiv.style.minHeight = '1.45em';
            loadingDiv.style.wordBreak = 'break-word';
            panel.appendChild(loadingDiv);

            const percentDiv = document.createElement('div');
            percentElRef.current = percentDiv;
            percentDiv.style.marginTop = '10px';
            percentDiv.style.fontSize = '15px';
            percentDiv.style.color = '#ffcc7a';
            percentDiv.style.display = 'none';
            panel.appendChild(percentDiv);

            const track = document.createElement('div');
            barTrackRef.current = track;
            track.style.marginTop = '12px';
            track.style.height = '14px';
            track.style.border = '1px solid rgba(255, 80, 80, 0.7)';
            track.style.background = 'rgba(20, 0, 0, 0.85)';
            track.style.boxSizing = 'border-box';
            track.style.display = 'none';
            track.style.overflow = 'hidden';
            panel.appendChild(track);

            const fill = document.createElement('div');
            barFillRef.current = fill;
            fill.style.height = '100%';
            fill.style.width = '0%';
            fill.style.background = 'linear-gradient(90deg, #8b0000 0%, #e03030 55%, #ffcc66 100%)';
            fill.style.transition = 'width 0.2s linear';
            track.appendChild(fill);

            const copyrightDiv = document.createElement('div');
            copyrightDiv.style.position = 'absolute';
            copyrightDiv.style.bottom = '10px';
            copyrightDiv.style.right = '10px';
            copyrightDiv.style.textAlign = 'right';
            copyrightDiv.style.fontSize = '13px';
            copyrightDiv.style.color = '#c8c8c8';
            copyrightElRef.current = copyrightDiv;
            div.appendChild(copyrightDiv);

            const disclaimerDiv = document.createElement('div');
            disclaimerDiv.style.position = 'absolute';
            disclaimerDiv.style.bottom = '10px';
            disclaimerDiv.style.left = '10px';
            disclaimerDiv.style.maxWidth = '45%';
            disclaimerDiv.style.fontSize = '12px';
            disclaimerDiv.style.color = '#a0a0a0';
            disclaimerElRef.current = disclaimerDiv;
            div.appendChild(disclaimerDiv);

            parentElement.appendChild(div);
            setRendered(true);
            if (onRender) {
                onRender();
            }
        }
    }, [parentElement, rendered, onRender]);
    useEffect(() => {
        if (elRef.current) {
            elRef.current.style.width = `${width}px`;
            elRef.current.style.height = `${height}px`;
        }
    }, [width, height]);
    useEffect(() => {
        if (elRef.current) {
            if (backgroundImage === "") {
                elRef.current.style.backgroundImage = 'radial-gradient(ellipse at 50% 35%, #3a0a0a 0%, #0a0000 70%)';
            }
            else if (backgroundImage) {
                elRef.current.style.backgroundImage = `url(${backgroundImage})`;
            }
        }
    }, [backgroundImage]);
    useEffect(() => {
        if (loadingElRef.current && loadingText !== undefined) {
            loadingElRef.current.innerHTML = loadingText.replace(/\n/g, '<br />');
        }
    }, [loadingText]);
    useEffect(() => {
        const hasProgress = typeof progress === 'number' && Number.isFinite(progress);
        if (barTrackRef.current) {
            barTrackRef.current.style.display = hasProgress ? 'block' : 'none';
        }
        if (percentElRef.current) {
            percentElRef.current.style.display = hasProgress ? 'block' : 'none';
            if (hasProgress) {
                const clamped = Math.max(0, Math.min(100, progress as number));
                percentElRef.current.textContent = `${Math.floor(clamped)}%`;
            }
        }
        if (barFillRef.current && hasProgress) {
            const clamped = Math.max(0, Math.min(100, progress as number));
            barFillRef.current.style.width = `${clamped}%`;
        }
    }, [progress]);
    useEffect(() => {
        if (copyrightElRef.current && copyrightText !== undefined) {
            copyrightElRef.current.innerHTML = copyrightText.replace(/\n/g, '<br />');
        }
    }, [copyrightText]);
    useEffect(() => {
        if (disclaimerElRef.current && disclaimerText !== undefined) {
            disclaimerElRef.current.innerHTML = disclaimerText.replace(/\n/g, '<br />');
        }
    }, [disclaimerText]);
    useEffect(() => {
        return () => {
            if (elRef.current && elRef.current.parentElement) {
                elRef.current.parentElement.removeChild(elRef.current);
            }
            setRendered(false);
        };
    }, []);
    return null;
};
export default SplashScreen;
