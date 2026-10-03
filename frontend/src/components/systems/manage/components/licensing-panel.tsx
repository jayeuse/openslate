"use client";

import { Badge } from "@/components/ui/badge";

export function LicensingPanel() {
  return (
    <section className="min-w-0 p-6" aria-labelledby="manage-license-heading">
      <div className="flex flex-col gap-5">
        <h2
          data-slot="section-title"
          id="manage-license-heading"
          className="text-xl font-semibold tracking-tight"
        >
          License & usage
        </h2>
        <div className="border-border border-b pb-5">
          <p className="text-muted-foreground text-sm">License</p>
          <p className="mt-1 text-2xl font-semibold">No license required</p>
          <Badge variant="secondary" className="mt-3">
            Self-hosted installation
          </Badge>
        </div>
        <p className="text-muted-foreground text-sm">
          This installation does not require a license key, activation, or
          renewal.
        </p>
        <div className="border-border border-t pt-5">
          <h3 data-slot="section-title" className="font-semibold">
            Usage
          </h3>
          <p className="text-muted-foreground mt-3 text-sm">
            Capacity depends on the resources configured by your server
            operator. No plan allowance or storage measurement is reported here.
          </p>
        </div>
      </div>
    </section>
  );
}
