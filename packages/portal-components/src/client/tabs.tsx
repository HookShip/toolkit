"use client";

// SPDX-License-Identifier: Apache-2.0

import { useEffect, useId, useState } from "react";
import type {
  HTMLAttributes,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";

import { classNames } from "../internal.js";

export interface TabItem {
  disabled?: boolean;
  href?: string;
  id: string;
  label: ReactNode;
  panel: ReactNode;
}

export interface TabsProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children" | "onChange"
> {
  defaultTab?: string;
  items: readonly TabItem[];
  label: string;
  queryParam?: string;
}

function focusTab(tabList: HTMLDivElement, tabId: string) {
  const tabs = tabList.querySelectorAll<HTMLElement>("[role='tab']");
  for (const tab of tabs) {
    if (tab.dataset.tabId === tabId) {
      tab.focus();
      return;
    }
  }
}

export function Tabs({
  className,
  defaultTab,
  items,
  label,
  queryParam,
  ...props
}: TabsProps) {
  const instanceId = useId();
  const enabledItems = items.filter((item) => item.disabled !== true);
  const fallbackId = enabledItems[0]?.id;
  const requestedDefault =
    defaultTab !== undefined &&
    enabledItems.some((item) => item.id === defaultTab)
      ? defaultTab
      : fallbackId;
  const [activeId, setActiveId] = useState(requestedDefault);
  const selectedId = enabledItems.some((item) => item.id === activeId)
    ? activeId
    : fallbackId;

  useEffect(() => {
    if (queryParam === undefined) return;
    const syncFromUrl = () => {
      const requested = new URL(window.location.href).searchParams.get(
        queryParam,
      );
      setActiveId(
        items.some((item) => item.disabled !== true && item.id === requested)
          ? (requested ?? requestedDefault)
          : requestedDefault,
      );
    };
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => {
      window.removeEventListener("popstate", syncFromUrl);
    };
  }, [items, queryParam, requestedDefault]);

  function updateUrl(href: string | undefined, replace = false) {
    if (href === undefined) return;
    window.history[replace ? "replaceState" : "pushState"](null, "", href);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (
      event.key !== "ArrowLeft" &&
      event.key !== "ArrowRight" &&
      event.key !== "Home" &&
      event.key !== "End"
    ) {
      return;
    }

    event.preventDefault();
    if (selectedId === undefined || enabledItems.length === 0) {
      return;
    }

    const currentIndex = enabledItems.findIndex(
      (item) => item.id === selectedId,
    );
    let nextIndex = currentIndex;

    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = enabledItems.length - 1;
    } else if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % enabledItems.length;
    } else {
      nextIndex =
        (currentIndex - 1 + enabledItems.length) % enabledItems.length;
    }

    const nextId = enabledItems[nextIndex]?.id;
    if (nextId !== undefined) {
      setActiveId(nextId);
      updateUrl(enabledItems[nextIndex]?.href, true);
      focusTab(event.currentTarget, nextId);
    }
  }

  function handleLinkClick(
    event: MouseEvent<HTMLAnchorElement>,
    item: TabItem,
  ) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    setActiveId(item.id);
    updateUrl(item.href);
  }

  return (
    <div {...props} className={classNames("whp-tabs", className)}>
      <div
        aria-label={label}
        className="whp-tabs__list"
        onKeyDown={handleKeyDown}
        role="tablist"
      >
        {items.map((item) => {
          const selected = item.id === selectedId;
          const tabId = `${instanceId}-tab-${item.id}`;
          const panelId = `${instanceId}-panel-${item.id}`;
          const tabProps = {
            "aria-controls": panelId,
            "aria-selected": selected,
            "data-tab-id": item.id,
            id: tabId,
            role: "tab" as const,
            tabIndex: selected ? 0 : -1,
          };

          return item.href !== undefined && item.disabled !== true ? (
            <a
              {...tabProps}
              href={item.href}
              key={item.id}
              onClick={(event) => {
                handleLinkClick(event, item);
              }}
            >
              {item.label}
            </a>
          ) : (
            <button
              {...tabProps}
              disabled={item.disabled}
              key={item.id}
              onClick={() => {
                setActiveId(item.id);
              }}
              type="button"
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {items.map((item) => {
        const selected = item.id === selectedId;
        const tabId = `${instanceId}-tab-${item.id}`;
        const panelId = `${instanceId}-panel-${item.id}`;

        return (
          <div
            aria-labelledby={tabId}
            className="whp-tabs__panel"
            data-print-label={
              typeof item.label === "string" ? item.label : undefined
            }
            hidden={!selected}
            id={panelId}
            key={item.id}
            role="tabpanel"
            tabIndex={0}
          >
            {item.panel}
          </div>
        );
      })}
    </div>
  );
}
