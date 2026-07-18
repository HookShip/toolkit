// SPDX-License-Identifier: Apache-2.0

import type { HTMLAttributes, ReactNode } from "react";

import { classNames } from "./internal.js";

export interface PortalShellProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "children"
> {
  aside?: ReactNode;
  children: ReactNode;
  mainId?: string;
  masthead?: ReactNode;
  navigation?: ReactNode;
}

export function PortalShell({
  aside,
  children,
  className,
  mainId = "portal-main",
  masthead,
  navigation,
  ...props
}: PortalShellProps) {
  return (
    <div {...props} className={classNames("whp-shell", className)}>
      {masthead === undefined ? null : masthead}
      <div className="whp-shell__frame">
        {navigation === undefined ? null : (
          <div className="whp-shell__navigation">{navigation}</div>
        )}
        <main className="whp-shell__main" id={mainId}>
          {children}
        </main>
        {aside === undefined ? null : (
          <aside className="whp-shell__aside">{aside}</aside>
        )}
      </div>
    </div>
  );
}

export interface MastheadProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> {
  actions?: ReactNode;
  brand: ReactNode;
  context?: ReactNode;
  homeHref?: string;
  skipHref?: string;
}

export function Masthead({
  actions,
  brand,
  className,
  context,
  homeHref = "/",
  skipHref = "#portal-main",
  ...props
}: MastheadProps) {
  return (
    <header {...props} className={classNames("whp-masthead", className)}>
      <a className="whp-skip-link" href={skipHref}>
        Skip to content
      </a>
      <a className="whp-masthead__brand" href={homeHref}>
        <span aria-hidden="true" className="whp-masthead__mark">
          <span />
          <span />
          <span />
        </span>
        <span>{brand}</span>
      </a>
      {context === undefined ? null : (
        <div className="whp-masthead__context">{context}</div>
      )}
      {actions === undefined ? null : (
        <div className="whp-masthead__actions">{actions}</div>
      )}
    </header>
  );
}

export interface BreadcrumbItem {
  href?: string;
  label: ReactNode;
}

export interface BreadcrumbsProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> {
  items: readonly BreadcrumbItem[];
  label?: string;
}

export function Breadcrumbs({
  className,
  items,
  label = "Breadcrumb",
  ...props
}: BreadcrumbsProps) {
  return (
    <nav
      {...props}
      aria-label={label}
      className={classNames("whp-breadcrumbs", className)}
    >
      <ol>
        {items.map((item, index) => {
          const current = index === items.length - 1;

          return (
            <li key={`${index}:${String(item.href)}`}>
              {current || item.href === undefined ? (
                <span aria-current={current ? "page" : undefined}>
                  {item.label}
                </span>
              ) : (
                <a href={item.href}>{item.label}</a>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export interface NavigationItem {
  current?: boolean;
  description?: ReactNode;
  href: string;
  label: ReactNode;
}

export interface PortalNavigationProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children"
> {
  items: readonly NavigationItem[];
  label?: string;
}

export function PortalNavigation({
  className,
  items,
  label = "Portal navigation",
  ...props
}: PortalNavigationProps) {
  return (
    <nav
      {...props}
      aria-label={label}
      className={classNames("whp-navigation", className)}
    >
      <ul>
        {items.map((item) => (
          <li key={item.href}>
            <a
              aria-current={item.current === true ? "page" : undefined}
              href={item.href}
            >
              <span>{item.label}</span>
              {item.description === undefined ? null : (
                <small>{item.description}</small>
              )}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export interface PageHeaderProps extends Omit<
  HTMLAttributes<HTMLElement>,
  "children" | "title"
> {
  actions?: ReactNode;
  breadcrumbs?: ReactNode;
  description?: ReactNode;
  eyebrow?: ReactNode;
  title: ReactNode;
}

export function PageHeader({
  actions,
  breadcrumbs,
  className,
  description,
  eyebrow,
  title,
  ...props
}: PageHeaderProps) {
  return (
    <header {...props} className={classNames("whp-page-header", className)}>
      {breadcrumbs === undefined ? null : breadcrumbs}
      <div className="whp-page-header__grid">
        <div>
          {eyebrow === undefined ? null : (
            <p className="whp-eyebrow">{eyebrow}</p>
          )}
          <h1>{title}</h1>
          {description === undefined ? null : (
            <div className="whp-page-header__description">{description}</div>
          )}
        </div>
        {actions === undefined ? null : (
          <div className="whp-page-header__actions">{actions}</div>
        )}
      </div>
    </header>
  );
}
