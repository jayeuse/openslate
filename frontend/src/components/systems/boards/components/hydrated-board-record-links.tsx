"use client";

import { createElement, useEffect, useState } from "react";
import { ServerBoardRecordLinks } from "./server-backed-board-record-links";

type Props = Parameters<typeof ServerBoardRecordLinks>[0];

export function HydratedBoardRecordLinks(props: Props) {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated ? createElement(ServerBoardRecordLinks, props) : null;
}
