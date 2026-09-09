import { useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { VirtualHost, VirtualViewport } from "./virtual-viewport";

interface VirtualRowsProps<T> {
  readonly viewport: VirtualViewport | null;
  readonly hosts: readonly VirtualHost[];
  readonly items: ReadonlyMap<string, T>;
  readonly renderItem: (item: T, id: string) => ReactNode;
}

/** Mounts React content only in visible hosts and releases hosts after portal removal. */
export function VirtualRows<T>({ viewport, hosts, items, renderItem }: VirtualRowsProps<T>) {
  useLayoutEffect(() => { viewport?.releaseHosts(hosts); }, [viewport, hosts]);
  return hosts.map(({ id, element }) => {
    const item = items.get(id);
    return item === undefined ? null : createPortal(renderItem(item, id), element, id);
  });
}
