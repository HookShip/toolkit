// SPDX-License-Identifier: Apache-2.0

import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

import { classNames } from "./internal.js";
import type { PortalTheme, PortalThemeTokens } from "./types.js";

type PortalCSSProperties = CSSProperties &
  Partial<Record<`--whp-${string}`, string>>;

export interface PortalProviderProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  children: ReactNode;
  density?: "comfortable" | "compact";
  theme?: PortalTheme;
  tokens?: PortalThemeTokens;
}

function themeTokenStyles(
  tokens: PortalThemeTokens | undefined,
): PortalCSSProperties {
  if (tokens === undefined) {
    return {};
  }

  return {
    ...(tokens.accent === undefined
      ? {}
      : { "--whp-color-accent": tokens.accent }),
    ...(tokens.background === undefined
      ? {}
      : { "--whp-color-background": tokens.background }),
    ...(tokens.border === undefined
      ? {}
      : { "--whp-color-border": tokens.border }),
    ...(tokens.critical === undefined
      ? {}
      : { "--whp-color-critical": tokens.critical }),
    ...(tokens.fontBody === undefined
      ? {}
      : { "--whp-font-body": tokens.fontBody }),
    ...(tokens.fontDisplay === undefined
      ? {}
      : { "--whp-font-display": tokens.fontDisplay }),
    ...(tokens.fontMono === undefined
      ? {}
      : { "--whp-font-mono": tokens.fontMono }),
    ...(tokens.ink === undefined ? {} : { "--whp-color-ink": tokens.ink }),
    ...(tokens.muted === undefined
      ? {}
      : { "--whp-color-muted": tokens.muted }),
    ...(tokens.radius === undefined ? {} : { "--whp-radius": tokens.radius }),
    ...(tokens.surface === undefined
      ? {}
      : { "--whp-color-surface": tokens.surface }),
    ...(tokens.warning === undefined
      ? {}
      : { "--whp-color-warning": tokens.warning }),
  };
}

/**
 * A server-renderable theme boundary. It uses data attributes and CSS custom
 * properties rather than React context, so it is safe in RSC and iframe hosts.
 */
export function PortalProvider({
  children,
  className,
  density = "comfortable",
  style,
  theme = "paper",
  tokens,
  ...props
}: PortalProviderProps) {
  return (
    <div
      {...props}
      className={classNames("whp", className)}
      data-whp-density={density}
      data-whp-theme={theme}
      style={{ ...themeTokenStyles(tokens), ...style }}
    >
      {children}
    </div>
  );
}
