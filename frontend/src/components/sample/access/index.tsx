"use client";
import Link from "next/link";
import { useCommsConfiguration } from "../comms/configuration-state";
import { resolveCommsPermission } from "../comms/configuration";
import { CHANNELS, CATEGORIES } from "../comms/model";
import { useState } from "react";
import {
  initialPeople,
  initialRoles,
  departments,
  permissions,
  type Person,
  type Role,
} from "./model";
import { Plus, Users, ShieldCheck, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSampleState } from "@/components/sample/sample-state";
import {
  Actions,
  Check,
  Choice,
  Editor,
  Field,
  Section,
  Tabs,
} from "./primitives";

export default function SampleAccess() {
  const [people, setPeople] = useSampleState<Person[]>(
    "access-people",
    initialPeople,
  );
  const [roles, setRoles] = useSampleState<Role[]>(
    "access-roles",
    initialRoles,
  );
  const [commsConfig] = useCommsConfiguration();
  const [commsChannels] = useSampleState("commsChannels", CHANNELS);
  const [commsCategories] = useSampleState("commsCategories", CATEGORIES);
  const [tab, setTab] = useState("Users");
  const [query, setQuery] = useState("");
  const [person, setPerson] = useState<Person | null>(() => {
    if (typeof window === "undefined") return null;
    const userId = new URLSearchParams(window.location.search).get("user");
    return people.find((item) => item.id === userId) ?? null;
  });
  const [role, setRole] = useState<Role | null>(null);
  const [selectedRole, setSelectedRole] = useState("sample-member");
  const [preview, setPreview] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const permissionRole =
    roles.find((item) => item.id === selectedRole) ?? roles[0];
  const lastAdmin = (item: Person) =>
    item.active &&
    item.role === "sample-admin" &&
    people.filter((user) => user.active && user.role === "sample-admin")
      .length === 1;
  const editPerson = (item: Person) => {
    setPerson({ ...item, departments: [...item.departments] });
    setError("");
    setDeleting(false);
  };
  const roleName = (id: string) =>
    roles.find((item) => item.id === id)?.name ?? "Unassigned";
  function savePerson() {
    if (!person) return;
    const previous = people.find((item) => item.id === person.id);
    if (
      previous &&
      lastAdmin(previous) &&
      (!person.active || person.role !== "sample-admin")
    ) {
      setError(
        "Keep the last active administrator active with the Administrator role.",
      );
      return;
    }
    if (!person.name.trim() || !person.email.endsWith("@example.invalid")) {
      setError("Use a name and a fictional email ending in @example.invalid.");
      return;
    }
    if (
      people.some(
        (item) =>
          item.id !== person.id &&
          item.email.toLowerCase() === person.email.toLowerCase(),
      )
    ) {
      setError("That sample email is already assigned.");
      return;
    }
    if (
      person.departments.length &&
      !person.departments.includes(person.primary)
    ) {
      setError("Choose a primary department from the assigned departments.");
      return;
    }
    const next = {
      ...person,
      name: person.name.trim(),
      activity: [
        ...person.activity,
        previous
          ? "Updated sample membership and role"
          : "Sample invitation prepared; no email sent",
      ],
    };
    setPeople((list) =>
      previous
        ? list.map((item) => (item.id === person.id ? next : item))
        : [...list, next],
    );
    setNotice(
      previous
        ? "Sample user updated."
        : "Sample invitation prepared. No email was sent.",
    );
    setPerson(null);
  }
  return (
    <div className="min-w-0 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Access</h1>
          <p className="text-muted-foreground mt-2">
            Manage users, roles, and department membership.
          </p>
        </div>
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Users className="size-4" />
          {people.filter((item) => item.active).length} active · {roles.length}{" "}
          roles
        </div>
      </header>
      <Tabs
        names={["Users", "Roles", "Permissions", "Membership"]}
        current={tab}
        set={setTab}
      />
      {notice && (
        <p
          role="status"
          className="bg-muted rounded-md border px-4 py-3 text-sm"
        >
          {notice}
        </p>
      )}
      {tab === "Users" && (
        <section aria-label="Users" className="space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="w-full sm:max-w-xs">
              <Field
                label="Search users"
                placeholder="Name or email"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <Button
              className="min-h-11"
              onClick={() =>
                editPerson({
                  id: `sample-user-${crypto.randomUUID()}`,
                  name: "",
                  email: "",
                  role: "sample-member",
                  active: true,
                  departments: ["Operations"],
                  primary: "Operations",
                  title: "",
                  activity: [],
                })
              }
            >
              <Plus />
              Invite user
            </Button>
          </div>
          <div className="divide-y rounded-lg border">
            {people
              .filter((item) =>
                `${item.name} ${item.email}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .map((item) => (
                <div
                  key={item.id}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 p-4 sm:grid-cols-[1fr_180px_auto]"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="bg-muted flex size-10 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                      {item.name
                        .split(" ")
                        .map((word) => word[0])
                        .join("")}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium">{item.name}</p>
                      <p className="text-muted-foreground truncate text-sm">
                        {item.email}
                      </p>
                    </div>
                  </div>
                  <p className="text-muted-foreground col-start-1 pl-13 text-xs sm:col-auto sm:p-0 sm:text-sm">
                    {roleName(item.role)} ·{" "}
                    {item.active ? "Active" : "Deactivated"}
                  </p>
                  <Button
                    variant="outline"
                    className="col-start-2 row-span-2 row-start-1 size-11 p-0 sm:col-auto sm:row-auto sm:w-auto sm:px-4"
                    aria-label={`Manage ${item.name}`}
                    onClick={() => editPerson(item)}
                  >
                    <span className="sr-only sm:not-sr-only">Manage</span>
                    <ArrowUpRight />
                  </Button>
                </div>
              ))}
            {!people.some((item) =>
              `${item.name} ${item.email}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            ) && (
              <p className="text-muted-foreground p-6 text-sm">
                No users match this search.
              </p>
            )}
          </div>
        </section>
      )}
      {tab === "Roles" && (
        <Section
          title="Roles"
          description="Start with a clear responsibility, then refine the permissions."
        >
          <Button
            className="min-h-11"
            onClick={() => {
              setRole({
                id: `sample-role-${crypto.randomUUID()}`,
                name: "",
                builtin: false,
                grants: [],
              });
              setError("");
            }}
          >
            <Plus />
            Create role
          </Button>
          <div className="grid gap-4 md:grid-cols-2">
            {roles.map((item) => (
              <div key={item.id} className="rounded-lg border p-5">
                <ShieldCheck className="mb-4 size-5" />
                <h3 className="font-semibold">{item.name}</h3>
                <p className="text-muted-foreground mt-1 text-sm">
                  {item.builtin ? "Built-in role" : "Custom role"} ·{" "}
                  {item.grants.length} permissions
                </p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    className="min-h-11"
                    onClick={() => {
                      setRole({ ...item });
                      setError("");
                    }}
                  >
                    Edit {item.name}
                  </Button>
                  <Button
                    variant="ghost"
                    className="min-h-11"
                    onClick={() => {
                      setRole({
                        ...item,
                        id: `sample-role-${crypto.randomUUID()}`,
                        name: `${item.name} copy`,
                        builtin: false,
                      });
                      setError("");
                    }}
                  >
                    Duplicate {item.name}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
      {tab === "Permissions" && permissionRole && (
        <Section
          title="Permission studio"
          description="Granular rules are a sample concept. Live authorization remains unchanged."
        >
          <div className="max-w-sm">
            <label className="grid gap-2 text-sm font-medium">
              Permission role
              <select
                className="bg-background min-h-11 rounded-md border px-3"
                value={permissionRole.id}
                onChange={(event) => {
                  setSelectedRole(event.target.value);
                  setPreview(false);
                }}
              >
                {roles.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="grid gap-x-8 rounded-lg border p-4 md:grid-cols-2">
            {permissions.map((permission) => (
              <Check
                key={permission}
                label={permission}
                checked={permissionRole.grants.includes(permission)}
                onChange={(checked) => {
                  if (permissionRole.id === "sample-admin") {
                    setNotice(
                      "Administrator has every sample permission. Duplicate it to explore restrictions.",
                    );
                    return;
                  }
                  setRoles((list) =>
                    list.map((item) =>
                      item.id === permissionRole.id
                        ? {
                            ...item,
                            grants: checked
                              ? [...item.grants, permission]
                              : item.grants.filter(
                                  (grant) => grant !== permission,
                                ),
                          }
                        : item,
                    ),
                  );
                }}
              />
            ))}
          </div>
          <section
            aria-label="OpenComms permissions"
            className="space-y-3 rounded-lg border p-4"
          >
            <h3 className="font-semibold">OpenComms permissions</h3>
            <p className="text-muted-foreground text-sm">
              Effective access for people in {permissionRole.name}, including
              individual exceptions. Configure these rules in OpenComms.
            </p>
            {commsChannels.map((channel) => {
              const members = people.filter(
                (person) => person.role === permissionRole.id,
              );
              const summary = (
                ["viewChannel", "post", "reply", "manageChannel"] as const
              ).map((action) => {
                const count = members.filter(
                  (person) =>
                    resolveCommsPermission(
                      commsConfig,
                      { person, channel, categories: commsCategories },
                      action,
                    ).allowed,
                ).length;
                const label = {
                  viewChannel: "View",
                  post: "Post",
                  reply: "Reply",
                  manageChannel: "Manage",
                }[action];
                return `${label}: ${count}/${members.length}`;
              });
              return (
                <div
                  key={channel.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 text-sm"
                >
                  <div>
                    <p className="font-medium">#{channel.name}</p>
                    <p className="text-muted-foreground">
                      {members.length
                        ? summary.join(" · ")
                        : "No people assigned to this role"}
                    </p>
                  </div>
                  <Link
                    className="inline-flex min-h-11 items-center underline"
                    href={`/comms?settings=permissions&role=${encodeURIComponent(permissionRole.id)}&channel=${encodeURIComponent(channel.id)}`}
                  >
                    Configure #{channel.name}
                  </Link>
                </div>
              );
            })}
          </section>
          <Button
            variant="outline"
            className="min-h-11"
            onClick={() => setPreview(!preview)}
          >
            Preview effective permissions
          </Button>
          {preview && (
            <section
              aria-label="Effective permissions"
              className="bg-muted rounded-lg border p-5"
            >
              <h3 className="mb-3 font-semibold">
                {permissionRole.name} · Effective permissions
              </h3>
              <p className="text-muted-foreground mb-3 text-sm">
                Granted permissions below; every unlisted permission is denied
                in this sample.
              </p>
              <ul className="grid gap-2 text-sm sm:grid-cols-2">
                {permissionRole.grants
                  .filter((grant) => permissions.includes(grant))
                  .map((grant) => (
                    <li key={grant}>{grant}</li>
                  ))}
              </ul>
              {!permissionRole.grants.length && <p>No access granted.</p>}
            </section>
          )}
        </Section>
      )}
      {tab === "Membership" && (
        <Section
          title="Organization chart"
          description="People can belong to multiple departments. Their primary department anchors their place in the organization."
        >
          <div className="grid gap-5 md:grid-cols-3">
            {departments.map((department) => (
              <section key={department} className="rounded-lg border">
                <h3 className="bg-muted border-b px-4 py-3 text-sm font-semibold">
                  {department}
                </h3>
                <div className="space-y-3 p-4">
                  {people
                    .filter((item) => item.departments.includes(department))
                    .map((item) => (
                      <button
                        key={item.id}
                        onClick={() => editPerson(item)}
                        className="hover:bg-muted focus-visible:outline-ring min-h-11 w-full rounded-md border p-3 text-left"
                      >
                        <p className="text-sm font-medium">{item.name}</p>
                        <p className="text-muted-foreground mt-1 text-xs">
                          {item.title || "No job title"} ·{" "}
                          {item.primary === department
                            ? "Primary"
                            : "Additional"}
                        </p>
                      </button>
                    ))}
                  {!people.some((item) =>
                    item.departments.includes(department),
                  ) && (
                    <p className="text-muted-foreground text-sm">
                      No members assigned.
                    </p>
                  )}
                </div>
              </section>
            ))}
          </div>
        </Section>
      )}
      <Editor
        title={
          person && people.some((item) => item.id === person.id)
            ? "Manage user"
            : "Invite user"
        }
        open={person !== null}
        onClose={() => setPerson(null)}
      >
        {person && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              savePerson();
            }}
            className="space-y-4"
          >
            <Field
              label="Full name"
              required
              value={person.name}
              onChange={(event) =>
                setPerson({ ...person, name: event.target.value })
              }
            />
            <Field
              label="Fictional email"
              type="email"
              required
              placeholder="name@example.invalid"
              value={person.email}
              onChange={(event) =>
                setPerson({ ...person, email: event.target.value })
              }
            />
            <Choice
              label="User role"
              value={roleName(person.role)}
              options={roles.map((item) => item.name)}
              onChange={(name) =>
                setPerson({
                  ...person,
                  role: roles.find((item) => item.name === name)!.id,
                })
              }
            />
            <Field
              label="Job title"
              value={person.title}
              onChange={(event) =>
                setPerson({ ...person, title: event.target.value })
              }
            />
            <fieldset>
              <legend className="text-sm font-medium">Departments</legend>
              {departments.map((department) => (
                <Check
                  key={department}
                  label={department}
                  checked={person.departments.includes(department)}
                  onChange={(checked) => {
                    const assigned = checked
                      ? [...person.departments, department]
                      : person.departments.filter(
                          (item) => item !== department,
                        );
                    setPerson({
                      ...person,
                      departments: assigned,
                      primary: assigned.includes(person.primary)
                        ? person.primary
                        : (assigned[0] ?? ""),
                    });
                  }}
                />
              ))}
            </fieldset>
            <Choice
              label="Primary department"
              value={person.primary}
              options={person.departments.length ? person.departments : [""]}
              onChange={(primary) => setPerson({ ...person, primary })}
            />
            <Check
              label="Active user"
              checked={person.active}
              onChange={(active) => setPerson({ ...person, active })}
            />
            {people.some((item) => item.id === person.id) && (
              <>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() =>
                      setPerson({
                        ...person,
                        activity: [
                          ...person.activity,
                          "Password reset preview prepared; no email sent",
                        ],
                      })
                    }
                  >
                    Preview password reset
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11"
                    onClick={() => {
                      const original = people.find(
                        (item) => item.id === person.id,
                      );
                      if (original && lastAdmin(original))
                        setError(
                          "Cannot delete the last active administrator.",
                        );
                      else setDeleting(true);
                    }}
                  >
                    Delete user
                  </Button>
                </div>
                {deleting && (
                  <div className="rounded-md border p-4">
                    <p className="text-sm">
                      Delete {person.name} from the sample workspace?
                    </p>
                    <Button
                      type="button"
                      variant="destructive"
                      className="mt-3 min-h-11"
                      onClick={() => {
                        setPeople((list) =>
                          list.filter((item) => item.id !== person.id),
                        );
                        setNotice("Sample user deleted.");
                        setPerson(null);
                      }}
                    >
                      Confirm sample deletion
                    </Button>
                  </div>
                )}
                <details className="rounded-md border p-3" open>
                  <summary className="min-h-11 cursor-pointer text-sm font-medium">
                    User activity log
                  </summary>
                  <ul className="text-muted-foreground space-y-2 text-sm">
                    {person.activity.map((activity, index) => (
                      <li key={`${index}-${activity}`}>{activity}</li>
                    ))}
                  </ul>
                </details>
              </>
            )}
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <Actions
              onCancel={() => setPerson(null)}
              save={
                people.some((item) => item.id === person.id)
                  ? "Save user"
                  : "Prepare sample invitation"
              }
            />
          </form>
        )}
      </Editor>
      <Editor
        title="Role settings"
        open={role !== null}
        onClose={() => setRole(null)}
      >
        {role && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!role.name.trim()) return;
              if (
                roles.some(
                  (item) =>
                    item.id !== role.id &&
                    item.name.toLowerCase() === role.name.trim().toLowerCase(),
                )
              ) {
                setError("A role with that name already exists.");
                return;
              }
              setRoles((list) =>
                list.some((item) => item.id === role.id)
                  ? list.map((item) =>
                      item.id === role.id
                        ? { ...role, name: role.name.trim() }
                        : item,
                    )
                  : [...list, { ...role, name: role.name.trim() }],
              );
              setNotice("Sample role saved. Refine its access in Permissions.");
              setRole(null);
            }}
            className="space-y-4"
          >
            <Field
              label="Role name"
              required
              value={role.name}
              onChange={(event) =>
                setRole({ ...role, name: event.target.value })
              }
            />
            <Choice
              label="Permission set"
              value={
                role.grants.length === permissions.length
                  ? "Full access"
                  : role.grants.length
                    ? "Custom / existing"
                    : "No access"
              }
              options={[
                "No access",
                "Read only",
                "Full access",
                "Custom / existing",
              ]}
              onChange={(value) => {
                if (role.id === "sample-admin") {
                  setError(
                    "Administrator retains full access. Duplicate the role to explore restrictions.",
                  );
                  return;
                }
                setRole({
                  ...role,
                  grants:
                    value === "Full access"
                      ? [...permissions]
                      : value === "Read only"
                        ? permissions.filter(
                            (item) =>
                              item.startsWith("Department") ||
                              item === "Action · read",
                          )
                        : value === "No access"
                          ? []
                          : role.grants,
                });
              }}
            />
            {roles.some((item) => item.id === role.id) && (
              <Button
                type="button"
                variant="outline"
                className="min-h-11"
                onClick={() => {
                  if (role.builtin) {
                    setError("Built-in roles cannot be deleted.");
                    return;
                  }
                  if (people.some((item) => item.role === role.id)) {
                    setError("Reassign users before deleting this role.");
                    return;
                  }
                  setRoles((list) =>
                    list.filter((item) => item.id !== role.id),
                  );
                  setRole(null);
                  setNotice("Sample role deleted.");
                }}
              >
                Delete role
              </Button>
            )}
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
            <Actions onCancel={() => setRole(null)} save="Save role" />
          </form>
        )}
      </Editor>
    </div>
  );
}
