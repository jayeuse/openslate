// Links drawn as tabs: each view has its own address, so they are links, not
// a tab panel. They carry the Tabs skin hooks (`tabs-list`, `tabs-trigger`
// with `data-active`, and `tabs-indicator`), so every look styles them as its
// tabs. The classes are the Tabs primitive's; the primitive is not imported.
export const linkTabsListClass =
  "text-muted-foreground relative flex w-fit items-center gap-1 rounded-[var(--radius)] bg-[var(--surface-sunken)] p-1 shadow-[inset_0_0_0_1px_var(--rule)] max-sm:w-full";
export const linkTabsTriggerClass =
  "focus-visible:outline-ring data-active:text-action-text relative isolate inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-sm px-3 text-sm font-medium whitespace-nowrap outline-none focus-visible:outline-2 data-active:font-semibold md:flex-none xl:min-h-7";
export const linkTabsIndicatorClass =
  "absolute inset-0 -z-10 rounded-[calc(var(--radius)*0.75)] bg-[var(--surface-raised)] shadow-[var(--lift),inset_0_0_0_1px_var(--rule)]";
