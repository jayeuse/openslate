"use client";

import { useEffect, useRef, useState } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import type { CommsPreferences } from "../domain/configuration";

type UseCommsPanelLayoutOptions = {
  preferences: CommsPreferences;
  hasThread: boolean;
  membersVisible: boolean;
};

export function useCommsPanelLayout({
  preferences,
  hasThread,
  membersVisible,
}: UseCommsPanelLayoutOptions) {
  const container = useRef<HTMLDivElement>(null);
  const channelsPanel = useRef<PanelImperativeHandle>(null);
  const rightPanel = useRef<PanelImperativeHandle>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [desktop, setDesktop] = useState(false);
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setContainerWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 768px)");
    const update = () => setDesktop(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1280px)");
    const update = () => setWide(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const availableWidth = containerWidth || 1200;
  const rightOpen = wide && (hasThread || membersVisible);
  const minimumChatWidth = Math.min(360, Math.max(280, availableWidth - 212));
  const channelMaximum = Math.max(
    200,
    Math.min(
      360,
      availableWidth -
        minimumChatWidth -
        (rightOpen ? (hasThread ? 320 : 200) : 0) -
        12,
    ),
  );
  const channelWidth = Math.round(
    Math.max(200, Math.min(channelMaximum, preferences.channelWidth)),
  );
  const memberMaximum = Math.max(
    200,
    Math.min(360, availableWidth - channelWidth - minimumChatWidth - 12),
  );
  const memberWidth = Math.round(
    Math.max(200, Math.min(memberMaximum, preferences.memberWidth)),
  );
  const threadMaximum = Math.max(
    320,
    Math.floor(
      Math.min(560, availableWidth - channelWidth - minimumChatWidth - 12),
    ),
  );
  const threadWidth = Math.round(
    Math.max(320, Math.min(threadMaximum, preferences.threadWidth)),
  );

  useEffect(() => {
    // Panel refs are exposed before the group commits its new layout.
    const frame = requestAnimationFrame(() => {
      if (
        desktop &&
        channelsPanel.current &&
        Math.abs(channelsPanel.current.getSize().inPixels - channelWidth) > 0.5
      )
        channelsPanel.current.resize(channelWidth);
      const width = hasThread ? threadWidth : memberWidth;
      if (
        rightOpen &&
        rightPanel.current &&
        Math.abs(rightPanel.current.getSize().inPixels - width) > 0.5
      )
        rightPanel.current.resize(width);
    });
    return () => cancelAnimationFrame(frame);
  }, [desktop, rightOpen, hasThread, channelWidth, memberWidth, threadWidth]);

  return {
    container,
    channelsPanel,
    rightPanel,
    containerWidth,
    desktop,
    wide,
    rightOpen,
    minimumChatWidth,
    channelMaximum,
    channelWidth,
    memberMaximum,
    memberWidth,
    threadMaximum,
    threadWidth,
  };
}
