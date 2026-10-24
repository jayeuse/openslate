import { expect, test } from "@playwright/test";
import { ZodError } from "zod";

import { ApiContractError, ApiError } from "../../../src/lib/api";
import {
  getPersonCard,
  getPersonProfile,
  personProfileFromSelf,
  profileNeedsSessionRecheck,
  readOwnAvatar,
  readPersonAvatar,
  readProfileSelf,
  reserveAvatar,
  saveProfile,
  uploadAvatar,
  validAvatarSelection,
} from "../../../src/components/profile/adapters/profile-api";
import {
  profileFacts,
  type ProfileAboutRow,
} from "../../../src/components/profile/domain/profile-rows";
import type { PersonProfile } from "../../../src/components/profile/adapters/profile-api";
import { installFetch } from "../platform/fixtures";

// The private profile, its photo and the shared person card trust a reply
// only in its exact shape, for the account or target that asked, and photo
// bytes only when typed, private, bounded and still bound to the current
// profile or card. The http journeys keep one example of each class with its
// exact wire body: "Profile refuses ${defect} private self data ..."
// (missing-phone, wrong-owner), "Profile rejects an invalid mime photo
// selection ...", "Profile refuses creator avatar metadata before binding",
// "Profile refuses private avatar mime delivery ...", "Person card rejects
// guest-private-key ..." and "Person card rejects mime avatar bytes ...".

const userA = "00000000-0000-4000-8000-000000000001";
const userB = "00000000-0000-4000-8000-000000000002";
const avatarFileId = "00000000-0000-4000-8000-000000000701";
const stamp = "2026-10-01T00:30:00Z";
const twoMebibytes = 2 * 1024 * 1024;
const avatarPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6X8AAAAASUVORK5CYII=",
  "base64",
);

function self(overrides: Record<string, unknown> = {}) {
  const flat = {
    id: userA,
    email: "person@example.test",
    username: "owned_person",
    role: "member",
    status: "active",
    display_name: "Maya Chen",
    job_title: "Equipment coordinator",
    phone: "+1 555 0101",
    bio: "Coordinates shared equipment.",
    avatar_file_id: null,
    sponsor_user_id: null,
    expires_at: null,
    invitation_sent_at: null,
    created_at: stamp,
    updated_at: stamp,
    deleted_at: null,
    is_deleted: false,
    performed_by: null,
    access: [],
  };
  const account = Object.fromEntries(
    Object.entries(flat).filter(
      ([key]) =>
        ![
          "role",
          "access",
          "sponsor_user_id",
          "expires_at",
          "invitation_sent_at",
        ].includes(key),
    ),
  );
  const org = {
    org_id: userB,
    name: "Example",
    slug: "example",
    role: flat.role,
  };
  return {
    ...flat,
    operator: false,
    account,
    memberships: [org],
    pending_invitations: [],
    current_organization: { ...org, access: flat.access, owner: false },
    default_organization_blocked: null,
    ...overrides,
  };
}

test("the private profile read asks the self route without a cache", async () => {
  const mock = installFetch(() => Response.json(self()));
  try {
    expect((await readProfileSelf(userA)).display_name).toBe("Maya Chen");
    expect(String(mock.requests[0]?.input)).toBe("/api/auth/me");
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("the private profile accepts an account without organization authority", async () => {
  const mock = installFetch(() =>
    Response.json(
      self({
        role: null,
        current_organization: null,
        memberships: [],
        pending_invitations: [],
      }),
    ),
  );
  try {
    expect((await readProfileSelf(userA)).role).toBeNull();
  } finally {
    mock.restore();
  }
});

test("the private profile retains the saved-organization refusal reason", async () => {
  const mock = installFetch(() =>
    Response.json(
      self({
        role: null,
        access: [],
        current_organization: null,
        default_organization_blocked: "organization_required",
      }),
    ),
  );
  try {
    expect((await readProfileSelf(userA)).default_organization_blocked).toBe(
      "organization_required",
    );
  } finally {
    mock.restore();
  }
});

const selfWithoutPhone: Record<string, unknown> = self();
delete selfWithoutPhone.phone;
const selfDefects: { name: string; body: unknown }[] = [
  { name: "a missing phone", body: selfWithoutPhone },
  { name: "an invalid photo id", body: self({ avatar_file_id: "not-a-uuid" }) },
  { name: "an extra key", body: self({ provider_secret: "Must not render" }) },
];

for (const row of selfDefects)
  test(`the private profile read refuses ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      await expect(readProfileSelf(userA)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  });

test("a private profile for another account is an owner mismatch that asks the session check", async () => {
  const mock = installFetch(() => Response.json(self({ id: userB })));
  try {
    const error = await readProfileSelf(userA).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      code: "profile_owner_mismatch",
    });
    expect(profileNeedsSessionRecheck(error)).toBe(true);
  } finally {
    mock.restore();
  }
});

const patches: {
  name: string;
  patch: Record<string, unknown>;
  valid: boolean;
}[] = [
  { name: "a cleared phone", patch: { phone: null }, valid: true },
  {
    name: "a 200-character name",
    patch: { display_name: "n".repeat(200) },
    valid: true,
  },
  {
    name: "a 201-character name",
    patch: { display_name: "n".repeat(201) },
    valid: false,
  },
  {
    name: "a 200-character job title",
    patch: { job_title: "t".repeat(200) },
    valid: true,
  },
  {
    name: "a 201-character job title",
    patch: { job_title: "t".repeat(201) },
    valid: false,
  },
  {
    name: "a 32-character phone",
    patch: { phone: "1".repeat(32) },
    valid: true,
  },
  {
    name: "a 33-character phone",
    patch: { phone: "1".repeat(33) },
    valid: false,
  },
  {
    name: "a bio of 280 four-byte code points",
    patch: { bio: "🌱".repeat(280) },
    valid: true,
  },
  {
    name: "a bio of 281 four-byte code points",
    patch: { bio: "🌱".repeat(281) },
    valid: false,
  },
  { name: "an empty patch", patch: {}, valid: false },
  {
    name: "an email change beside a phone",
    patch: { phone: null, email: "new@example.test" },
    valid: false,
  },
];

for (const row of patches)
  test(`a profile save with ${row.name} is ${row.valid ? "sent" : "refused before a request"}`, async () => {
    const mock = installFetch(() => Response.json(self()));
    try {
      const result = await saveProfile(userA, row.patch).catch(
        (caught: unknown) => caught,
      );
      if (row.valid) {
        expect(result).toMatchObject({ id: userA });
        expect(mock.requests[0]?.init?.body).toBe(JSON.stringify(row.patch));
      } else {
        expect(result).toBeInstanceOf(ZodError);
        expect(mock.requests).toEqual([]);
      }
    } finally {
      mock.restore();
    }
  });

const selections: {
  name: string;
  size: number;
  type: string;
  valid: boolean;
}[] = [
  { name: "a 1-byte PNG", size: 1, type: "image/png", valid: true },
  { name: "a 2 MiB JPEG", size: twoMebibytes, type: "image/jpeg", valid: true },
  { name: "an HTML file", size: 4, type: "text/html", valid: false },
  { name: "an empty PNG", size: 0, type: "image/png", valid: false },
  {
    name: "a PNG of 2 MiB and 1 byte",
    size: twoMebibytes + 1,
    type: "image/png",
    valid: false,
  },
];

for (const row of selections)
  test(`photo selection ${row.valid ? "accepts" : "refuses"} ${row.name}`, () => {
    const file = new File([new Uint8Array(row.size)], "portrait.png", {
      type: row.type,
    });
    expect(validAvatarSelection(file)).toBe(row.valid);
  });

function avatarFile(
  state: "awaiting_upload" | "ready",
  overrides: Record<string, unknown> = {},
) {
  return {
    id: avatarFileId,
    purpose: "user_avatar",
    filename: "portrait.png",
    expected_size: avatarPng.length,
    creator_id: userA,
    record_id: null,
    department_id: null,
    board_id: null,
    actual_size: state === "ready" ? avatarPng.length : null,
    media_type: state === "ready" ? "image/png" : null,
    state,
    failure_code: null,
    is_deleted: false,
    created_at: stamp,
    updated_at: stamp,
    ...overrides,
  };
}
const portrait = () =>
  new File([avatarPng], "portrait.png", { type: "image/png" });

test("a photo reservation names only the file and its purpose", async () => {
  const mock = installFetch(() =>
    Response.json(avatarFile("awaiting_upload"), { status: 201 }),
  );
  try {
    expect((await reserveAvatar(userA, portrait())).id).toBe(avatarFileId);
    expect(String(mock.requests[0]?.input)).toBe("/api/files");
    expect(JSON.parse(String(mock.requests[0]?.init?.body))).toEqual({
      filename: "portrait.png",
      expected_size: avatarPng.length,
      purpose: "user_avatar",
    });
  } finally {
    mock.restore();
  }
});

// Each defect came from the http loop "Profile refuses ${defect} avatar
// metadata before binding"; the first four apply to both replies.
const reservationDefects: {
  name: string;
  overrides: Record<string, unknown>;
}[] = [
  { name: "another creator", overrides: { creator_id: userB } },
  { name: "the logo purpose", overrides: { purpose: "workspace_logo" } },
  { name: "a parent record", overrides: { record_id: userB } },
  {
    name: "an expected size over 2 MiB",
    overrides: { expected_size: twoMebibytes + 1 },
  },
];
const uploadDefects = [
  ...reservationDefects,
  { name: "an HTML media type", overrides: { media_type: "text/html" } },
  {
    name: "a state still awaiting upload",
    overrides: { state: "awaiting_upload" },
  },
  { name: "no actual size", overrides: { actual_size: null } },
  { name: "another file id", overrides: { id: userB } },
];

for (const row of reservationDefects)
  test(`a photo reservation with ${row.name} is refused`, async () => {
    const mock = installFetch(() =>
      Response.json(avatarFile("awaiting_upload", row.overrides), {
        status: 201,
      }),
    );
    try {
      await expect(reserveAvatar(userA, portrait())).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  });

test("a photo upload sends the bytes and returns the ready file", async () => {
  const mock = installFetch(() => Response.json(avatarFile("ready")));
  try {
    expect((await uploadAvatar(userA, avatarFileId, portrait())).state).toBe(
      "ready",
    );
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/files/${avatarFileId}/content`,
    );
    expect(mock.requests[0]?.init?.method).toBe("PUT");
    expect(
      new Headers(mock.requests[0]?.init?.headers).get("Content-Type"),
    ).toBe("application/octet-stream");
  } finally {
    mock.restore();
  }
});

for (const row of uploadDefects)
  test(`a photo upload reply with ${row.name} is refused`, async () => {
    const mock = installFetch(() =>
      Response.json(avatarFile("ready", row.overrides)),
    );
    try {
      await expect(
        uploadAvatar(userA, avatarFileId, portrait()),
      ).rejects.toBeInstanceOf(ApiContractError);
    } finally {
      mock.restore();
    }
  });

type Bytes = {
  type?: string;
  cache?: string | null;
  nosniff?: string | null;
  body?: Buffer;
};
function avatarBytes(bytes: Bytes) {
  const headers = new Headers({ "Content-Type": bytes.type ?? "image/png" });
  const cache = bytes.cache === undefined ? "private, no-store" : bytes.cache;
  const nosniff = bytes.nosniff === undefined ? "nosniff" : bytes.nosniff;
  if (cache !== null) headers.set("Cache-Control", cache);
  if (nosniff !== null) headers.set("X-Content-Type-Options", nosniff);
  return new Response(new Uint8Array(bytes.body ?? avatarPng), { headers });
}
function ownAvatarApi(bytes: Bytes, boundAvatar: string | null = avatarFileId) {
  return installFetch((input) =>
    String(input) === `/api/users/${userA}/avatar`
      ? avatarBytes(bytes)
      : Response.json(self({ avatar_file_id: boundAvatar })),
  );
}

test("own photo bytes still bound to the profile become a private image", async () => {
  const mock = ownAvatarApi({});
  try {
    const blob = await readOwnAvatar(userA, avatarFileId);
    expect(blob.type).toBe("image/png");
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(avatarPng);
    expect(mock.requests[0]?.init?.redirect).toBe("error");
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

// The first three faults came from the profile delivery loop, the next three
// from the person card byte loop; both readers share one byte check.
const byteFaults: { name: string; bytes: Bytes }[] = [
  { name: "an HTML media type", bytes: { type: "text/html" } },
  {
    name: "a body of 2 MiB and 1 byte",
    bytes: { body: Buffer.alloc(twoMebibytes + 1) },
  },
  {
    name: "no cache or nosniff headers",
    bytes: { cache: null, nosniff: null },
  },
  { name: "an SVG media type", bytes: { type: "image/svg+xml" } },
  { name: "an empty body", bytes: { body: Buffer.alloc(0) } },
  { name: "a shared cache header", bytes: { cache: "no-store" } },
  { name: "a cache header without no-store", bytes: { cache: "private" } },
  { name: "a missing nosniff header", bytes: { nosniff: null } },
];

for (const row of byteFaults)
  test(`own photo bytes with ${row.name} are refused before the binding check`, async () => {
    const mock = ownAvatarApi(row.bytes);
    try {
      await expect(readOwnAvatar(userA, avatarFileId)).rejects.toBeInstanceOf(
        ApiContractError,
      );
      expect(mock.requests).toHaveLength(1);
    } finally {
      mock.restore();
    }
  });

test("own photo bytes are dropped when the profile names another photo", async () => {
  const mock = ownAvatarApi({}, null);
  try {
    await expect(readOwnAvatar(userA, avatarFileId)).rejects.toBeInstanceOf(
      ApiContractError,
    );
  } finally {
    mock.restore();
  }
});

const target = "00000000-0000-4000-8000-000000000011";
const otherUser = "00000000-0000-4000-8000-000000000901";
const member = { id: userA, role: "member" as const };
const guest = { id: userA, role: "guest" as const };
const publicCard = {
  display_name: "Ana Santos",
  job_title: "Equipment coordinator",
  avatar_url: null,
};
const memberCard = {
  ...publicCard,
  email: "ana@example.test",
  phone: "+1 555 0123",
  bio: "Coordinates equipment and maintenance.",
};

test("a member reads the full person card without a cache or an auth refresh", async () => {
  const mock = installFetch(() => Response.json(memberCard));
  try {
    const card = await getPersonCard(member, target);
    expect(card).toEqual({
      viewer: member,
      targetId: target,
      data: memberCard,
    });
    expect(String(mock.requests[0]?.input)).toBe(`/api/users/${target}/card`);
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("a guest reads the public person card", async () => {
  const mock = installFetch(() => Response.json(publicCard));
  try {
    expect((await getPersonCard(guest, target)).data).toEqual(publicCard);
  } finally {
    mock.restore();
  }
});

const memberCardWithoutPhone: Record<string, unknown> = { ...memberCard };
delete memberCardWithoutPhone.phone;
// Each body came from the http loop "Person card rejects ${fault} without
// leaking response metadata or fetching unsafe photos".
const cardDefects: {
  name: string;
  viewer: typeof member | typeof guest;
  body: unknown;
}[] = [
  {
    name: "a guest card with a private key",
    viewer: guest,
    body: { ...publicCard, email: "private@example.test" },
  },
  {
    name: "a member card without its phone",
    viewer: member,
    body: memberCardWithoutPhone,
  },
  {
    name: "a card with an id",
    viewer: member,
    body: { ...memberCard, id: target },
  },
  {
    name: "an external photo URL",
    viewer: member,
    body: { ...memberCard, avatar_url: "https://example.test/private.png" },
  },
  {
    name: "another person's photo URL",
    viewer: member,
    body: { ...memberCard, avatar_url: `/api/users/${otherUser}/avatar` },
  },
];

for (const row of cardDefects)
  test(`the person card refuses ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      await expect(getPersonCard(row.viewer, target)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  });

test("a refused person card keeps its status without an auth refresh", async () => {
  const mock = installFetch(() =>
    Response.json({ detail: "Private source exception" }, { status: 401 }),
  );
  try {
    await expect(getPersonCard(member, target)).rejects.toMatchObject({
      status: 401,
    });
    expect(mock.requests).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

const ownPhoto = `/api/users/${target}/avatar`;
function personAvatarApi(card: unknown, bytes: Bytes = {}) {
  return installFetch((input) =>
    String(input) === ownPhoto
      ? avatarBytes(bytes)
      : card instanceof Response
        ? card
        : Response.json(card),
  );
}

test("a person photo keeps its bytes while the current card names it", async () => {
  const mock = personAvatarApi({ ...memberCard, avatar_url: ownPhoto });
  try {
    const result = await readPersonAvatar({
      viewer: member,
      targetId: target,
      avatarUrl: ownPhoto,
    });
    expect(result.status).toBe("ready");
    expect(result.status === "ready" && result.blob?.type).toBe("image/png");
  } finally {
    mock.restore();
  }
});

test("a person photo drops its bytes when the current card no longer names it", async () => {
  const mock = personAvatarApi(memberCard);
  try {
    const result = await readPersonAvatar({
      viewer: member,
      targetId: target,
      avatarUrl: ownPhoto,
    });
    expect(result).toMatchObject({ status: "ready", blob: null });
  } finally {
    mock.restore();
  }
});

test("a person photo reports an unavailable card when the card read fails", async () => {
  const mock = personAvatarApi(
    Response.json({ detail: "Not found" }, { status: 404 }),
  );
  try {
    const result = await readPersonAvatar({
      viewer: member,
      targetId: target,
      avatarUrl: ownPhoto,
    });
    expect(result.status).toBe("card-unavailable");
  } finally {
    mock.restore();
  }
});

test("a person photo bound to another person is refused before any request", async () => {
  const mock = personAvatarApi(memberCard);
  try {
    await expect(
      readPersonAvatar({
        viewer: member,
        targetId: target,
        avatarUrl: `/api/users/${otherUser}/avatar`,
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
    expect(mock.requests).toEqual([]);
  } finally {
    mock.restore();
  }
});

test("person photo bytes with an SVG media type are refused before the card check", async () => {
  const mock = personAvatarApi(
    { ...memberCard, avatar_url: ownPhoto },
    { type: "image/svg+xml" },
  );
  try {
    await expect(
      readPersonAvatar({
        viewer: member,
        targetId: target,
        avatarUrl: ownPhoto,
      }),
    ).rejects.toBeInstanceOf(ApiContractError);
    expect(mock.requests).toHaveLength(1);
  } finally {
    mock.restore();
  }
});

// The Profile view (PD16–PD18): the server sends the full profile to
// administrators and members and the three public fields to guests; the view
// shows a row only for a field with a value.
const fullProfile = {
  display_name: "Rosa Reyes",
  job_title: "Dispatch coordinator",
  avatar_url: `/api/users/${target}/avatar`,
  phone: "+63 917 555 0118",
  bio: "Coordinates the morning dispatch.",
  role: "member",
  groups: [
    { id: "00000000-0000-4000-8000-000000000a01", name: "Field Ops" },
    { id: "00000000-0000-4000-8000-000000000a02", name: "Quality Review" },
  ],
};
const guestProfile = {
  display_name: "Rosa Reyes",
  job_title: "Dispatch coordinator",
  avatar_url: null,
};

test("a full profile maps to the Profile view without a cache or an auth refresh", async () => {
  const mock = installFetch(() => Response.json(fullProfile));
  try {
    expect(await getPersonProfile(target)).toEqual({
      personId: target,
      displayName: "Rosa Reyes",
      jobTitle: "Dispatch coordinator",
      avatarUrl: `/api/users/${target}/avatar`,
      phone: "+63 917 555 0118",
      bio: "Coordinates the morning dispatch.",
      role: "member",
      groups: [
        { id: "00000000-0000-4000-8000-000000000a01", name: "Field Ops" },
        { id: "00000000-0000-4000-8000-000000000a02", name: "Quality Review" },
      ],
    });
    expect(String(mock.requests[0]?.input)).toBe(
      `/api/users/${target}/profile`,
    );
    expect(mock.requests[0]?.init?.cache).toBe("no-store");
  } finally {
    mock.restore();
  }
});

test("a guest's profile has no phone, bio, role or groups", async () => {
  const mock = installFetch(() => Response.json(guestProfile));
  try {
    expect(await getPersonProfile(target)).toEqual({
      personId: target,
      displayName: "Rosa Reyes",
      jobTitle: "Dispatch coordinator",
      avatarUrl: null,
      phone: null,
      bio: null,
      role: null,
      groups: [],
    });
  } finally {
    mock.restore();
  }
});

const profileWithoutGroups: Record<string, unknown> = { ...fullProfile };
delete profileWithoutGroups.groups;
for (const row of [
  { name: "a full profile without its groups", body: profileWithoutGroups },
  { name: "a profile with an id", body: { ...fullProfile, id: target } },
  {
    name: "a public profile with a private key",
    body: { ...guestProfile, phone: "+1 555 0000" },
  },
  { name: "an unknown role", body: { ...fullProfile, role: "owner" } },
  {
    name: "an external photo URL",
    body: { ...fullProfile, avatar_url: "https://example.test/private.png" },
  },
  {
    name: "another person's photo URL",
    body: { ...fullProfile, avatar_url: `/api/users/${otherUser}/avatar` },
  },
])
  test(`the profile read refuses ${row.name}`, async () => {
    const mock = installFetch(() => Response.json(row.body));
    try {
      await expect(getPersonProfile(target)).rejects.toBeInstanceOf(
        ApiContractError,
      );
    } finally {
      mock.restore();
    }
  });

test("an unavailable profile keeps its 404 so the view can say so", async () => {
  const mock = installFetch(() =>
    Response.json(
      { detail: { code: "person_not_found", message: "Person not found" } },
      { status: 404 },
    ),
  );
  try {
    await expect(getPersonProfile(target)).rejects.toMatchObject({
      status: 404,
      code: "person_not_found",
    });
  } finally {
    mock.restore();
  }
});

const mapped: PersonProfile = {
  personId: target,
  displayName: "Rosa Reyes",
  jobTitle: "Dispatch coordinator",
  avatarUrl: null,
  phone: "+63 917 555 0118",
  bio: "Coordinates the morning dispatch.",
  role: "member",
  groups: [{ id: "00000000-0000-4000-8000-000000000a01", name: "Field Ops" }],
};
const factRows: {
  name: string;
  profile: PersonProfile;
  own?: boolean;
  about: ProfileAboutRow[];
  bio: string | null;
  fillHint?: boolean;
}[] = [
  {
    name: "every filled field",
    profile: mapped,
    about: [
      { label: "Phone", value: "+63 917 555 0118", href: "tel:+639175550118" },
      { label: "Role", value: "Member" },
      { label: "Groups", groups: mapped.groups },
    ],
    bio: "Coordinates the morning dispatch.",
  },
  {
    name: "no row for a blank phone, no groups and no Bio panel for a blank bio",
    profile: { ...mapped, phone: "  ", bio: " ", role: "admin", groups: [] },
    about: [{ label: "Role", value: "Administrator" }],
    bio: null,
  },
  {
    name: "the guest role label",
    profile: { ...mapped, phone: null, bio: null, role: "guest", groups: [] },
    about: [{ label: "Role", value: "Guest" }],
    bio: null,
  },
  {
    name: "nothing beside the name for a guest's view",
    profile: { ...mapped, phone: null, bio: null, role: null, groups: [] },
    about: [],
    bio: null,
  },
  {
    name: "the fill hint on your own profile with no job title, phone or bio",
    profile: {
      ...mapped,
      jobTitle: " ",
      phone: null,
      bio: "",
      role: "admin",
      groups: [],
    },
    own: true,
    about: [{ label: "Role", value: "Administrator" }],
    bio: null,
    fillHint: true,
  },
  {
    name: "no fill hint on a guest's own profile, whose view has no phone or bio",
    profile: {
      ...mapped,
      jobTitle: null,
      phone: null,
      bio: null,
      role: null,
      groups: [],
    },
    own: true,
    about: [],
    bio: null,
  },
  {
    name: "no fill hint on your own profile once one of them is filled",
    profile: { ...mapped, phone: null, bio: null, role: "admin", groups: [] },
    own: true,
    about: [{ label: "Role", value: "Administrator" }],
    bio: null,
  },
  {
    name: "no fill hint on another person's bare profile",
    profile: {
      ...mapped,
      jobTitle: null,
      phone: null,
      bio: null,
      role: "member",
      groups: [],
    },
    about: [{ label: "Role", value: "Member" }],
    bio: null,
  },
];
for (const row of factRows)
  test(`the Profile view shows ${row.name}`, () => {
    expect(profileFacts(row.profile, row.own ?? false)).toEqual({
      about: row.about,
      bio: row.bio,
      fillHint: row.fillHint ?? false,
    });
  });

test("without an organization the own profile comes from the account, with no role or groups", () => {
  const account = self({ display_name: null });
  expect(personProfileFromSelf(account as never)).toEqual({
    personId: userA,
    displayName: "owned_person",
    jobTitle: "Equipment coordinator",
    avatarUrl: null,
    phone: "+1 555 0101",
    bio: "Coordinates shared equipment.",
    role: null,
    groups: [],
  });
});
