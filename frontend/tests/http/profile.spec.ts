import { expect, test } from "./helpers/test";
import {
  avatarFileId,
  avatarPng,
  installProfileApi,
  observeProfilePhotoRevocations,
  profileGate,
  profileUserA,
  profileUserB,
} from "./helpers/profile-api";
import { concealMfaTestCredentials, mockMfa } from "./helpers/mfa";

test.use({ trace: "off", screenshot: "off", video: "off" });

for (const role of ["member", "guest"] as const) {
  test(`Profile ${role} edits only changed private self fields and reloads without shared access`, async ({
    page,
  }) => {
    const api = await installProfileApi(page, { role });
    await page.goto("/profile");
    await expect(
      page.getByRole("heading", { name: "Your profile", exact: true }),
    ).toBeVisible();
    for (const name of [
      "Identity",
      "Sign-in & security",
      "Look & behavior",
      "Regional",
    ]) {
      await expect(
        page.getByRole("heading", { name, exact: true }),
      ).toBeVisible();
    }
    await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
      "+1 555 0101",
    );
    await expect(
      page.getByText("person@example.test", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /change email/i }),
    ).toHaveCount(0);
    const save = page.getByRole("button", {
      name: "Save identity",
      exact: true,
    });
    await expect(save).toBeDisabled();
    await page.getByLabel("Phone", { exact: true }).fill("+1 555 0102");
    const reads = api.selfReads.length;
    await save.click();
    await expect(
      page.getByRole("status").filter({ hasText: /profile saved/i }),
    ).toBeVisible();
    await expect.poll(() => api.selfReads.length).toBeGreaterThan(reads);
    expect(api.writes).toEqual([
      {
        method: "PATCH",
        path: "/api/auth/me/profile",
        body: { phone: "+1 555 0102" },
        userId: profileUserA,
      },
    ]);
    expect(api.people.get(profileUserA)).toMatchObject({
      display_name: "Maya Chen",
      job_title: "Equipment coordinator",
      bio: "Coordinates shared equipment.",
      phone: "+1 555 0102",
    });
    await page.reload();
    await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
      "+1 555 0102",
    );
    await expect(save).toBeDisabled();
    expect(api.forbiddenReads).toEqual([]);
  });
}

test("Profile clears nullable values explicitly and rejects overlong Unicode before writing", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  await page.goto("/profile");
  const phone = page.getByLabel("Phone", { exact: true });
  await expect(phone).toHaveValue("+1 555 0101");
  await phone.fill("");
  await page
    .getByRole("button", { name: "Save identity", exact: true })
    .click();
  await expect.poll(() => api.people.get(profileUserA)?.phone).toBeNull();
  expect(api.writes[0]?.body).toEqual({ phone: null });
  const bio = page.getByLabel("Short bio", { exact: true });
  await bio.fill("🌱".repeat(281));
  await page
    .getByRole("button", { name: "Save identity", exact: true })
    .click();
  await expect(
    page.getByRole("alert").filter({ hasText: /280/ }),
  ).toBeVisible();
  await expect(bio).toHaveAttribute("aria-invalid", "true");
  expect(api.writes).toHaveLength(1);
});

for (const failure of [422, 503] as const) {
  test(`Profile ${failure} preserves a text draft and a read Retry never replays a write`, async ({
    page,
  }) => {
    const api = await installProfileApi(page);
    api.patchStatus = failure;
    await page.goto("/profile");
    const phone = page.getByLabel("Phone", { exact: true });
    await expect(phone).toHaveValue("+1 555 0101");
    await phone.fill("Retained draft");
    await page
      .getByRole("button", { name: "Save identity", exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({
        hasText: /profile.*(not|could|unable|unavailable|rejected)/i,
      }),
    ).toBeVisible();
    await expect(phone).toHaveValue("Retained draft");
    await expect(
      page.getByText("Private server detail", { exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("Profile saved.", { exact: true })).toHaveCount(
      0,
    );
    api.patchStatus = 200;
    await page
      .getByRole("button", { name: "Reload profile", exact: true })
      .click();
    await expect(phone).toHaveValue("Retained draft");
    expect(api.writes).toHaveLength(1);
    expect(api.people.get(profileUserA)?.phone).toBe("+1 555 0101");
  });
}

for (const defect of [
  "missing-phone",
  "wrong-owner",
  "invalid-avatar",
  "extra",
] as const) {
  test(`Profile refuses ${defect} private self data instead of inventing nullable defaults`, async ({
    page,
  }) => {
    const api = await installProfileApi(page);
    api.selfShape = (body) => {
      if (defect === "missing-phone") {
        const { phone: omitted, ...rest } = body;
        void omitted;
        return rest;
      }
      if (defect === "wrong-owner") return { ...body, id: profileUserB };
      if (defect === "invalid-avatar")
        return { ...body, avatar_file_id: "not-a-uuid" };
      return { ...body, provider_secret: "Must not render" };
    };
    await page.goto("/profile");
    await expect(
      page.getByRole("alert").filter({
        hasText: /profile.*(unavailable|not|could|unable|invalid)/i,
      }),
    ).toBeVisible();
    await expect(page.getByLabel("Phone", { exact: true })).not.toHaveValue(
      "+1 555 0101",
    );
    await expect(page.getByText("Must not render")).toHaveCount(0);
    expect(api.writes).toEqual([]);
    expect(api.forbiddenReads).toEqual([]);
  });
}

test("Profile serializes pending edits and ignores a late old-account completion", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  await page.goto("/profile");
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
    "+1 555 0101",
  );
  const hold = profileGate();
  api.holdPatch = hold;
  try {
    await page.getByLabel("Phone", { exact: true }).fill("Owned delayed edit");
    await page
      .getByRole("button", { name: "Save identity", exact: true })
      .click();
    await hold.begun;
    await expect(
      page.getByRole("button", { name: "Save identity", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByLabel("Upload photo", { exact: true }),
    ).toBeDisabled();
    api.userId = profileUserB;
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Second person",
    );
    hold.release();
    await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
      "+1 555 0101",
    );
    await expect(page.getByText("Profile saved.", { exact: true })).toHaveCount(
      0,
    );
    expect(api.writes).toHaveLength(1);
  } finally {
    hold.release();
  }
});

test("Profile section anchors keep an unsaved identity draft and guarded navigation can cancel", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.goto("/profile");
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Maya Chen",
  );
  await page
    .getByLabel("Display name", { exact: true })
    .fill("Unsaved owned name");
  await page
    .getByRole("navigation", { name: "Profile sections", exact: true })
    .getByRole("link", { name: "Regional", exact: true })
    .click();
  await expect(page).toHaveURL(/\/profile#regional$/);
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Unsaved owned name",
  );
  await page
    .getByRole("complementary", { name: "Primary sidebar", exact: true })
    .getByRole("link", { name: "OpenComms", exact: true })
    .click();
  const dialog = page.getByRole("alertdialog").filter({ hasText: /unsaved/i });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: /cancel|keep editing/i }).click();
  await expect(page).toHaveURL(/\/profile#regional$/);
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Unsaved owned name",
  );
});

test("Profile uploads and clears an owned private avatar without purge or automatic replay", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  const revoked = await observeProfilePhotoRevocations(page);
  await page.goto("/profile");
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Maya Chen",
  );
  await page.getByLabel("Upload photo", { exact: true }).setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: avatarPng,
  });
  await expect(
    page.getByRole("img", { name: "Your profile photo", exact: true }),
  ).toBeVisible();
  expect(api.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /api/files",
    `PUT /api/files/${avatarFileId}/content`,
    "PATCH /api/auth/me/profile",
  ]);
  expect(api.writes[2]?.body).toEqual({ avatar_file_id: avatarFileId });
  expect(api.avatarReads.every((id) => id === profileUserA)).toBe(true);
  const photoUrl = await page
    .getByRole("img", { name: "Your profile photo", exact: true })
    .getAttribute("src");
  expect(photoUrl).toMatch(/^blob:/);
  await page.getByRole("button", { name: "Remove photo", exact: true }).click();
  await expect(
    page.getByRole("img", { name: "Your profile photo", exact: true }),
  ).toHaveCount(0);
  await expect.poll(() => revoked).toContain(photoUrl);
  expect(api.people.get(profileUserA)?.avatar_file_id).toBeNull();
  expect(api.writes.at(-1)?.body).toEqual({ avatar_file_id: null });
  expect(api.writes.filter(({ path }) => /purge|reconcile/.test(path))).toEqual(
    [],
  );
});

for (const invalid of ["mime", "size"] as const) {
  test(`Profile rejects an invalid ${invalid} photo selection before reservation`, async ({
    page,
  }) => {
    const api = await installProfileApi(page);
    await page.goto("/profile");
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Maya Chen",
    );
    await page.getByLabel("Upload photo", { exact: true }).setInputFiles({
      name: "portrait.png",
      mimeType: invalid === "mime" ? "text/html" : "image/png",
      buffer:
        invalid === "size" ? Buffer.alloc(2 * 1024 * 1024 + 1) : avatarPng,
    });
    await expect(
      page.getByRole("alert").filter({ hasText: /PNG.*JPEG.*2/i }),
    ).toBeVisible();
    expect(api.writes).toEqual([]);
  });
}

for (const defect of [
  "creator",
  "purpose",
  "parent",
  "size",
  "ready-mime",
  "ready-state",
  "actual-size",
  "upload-id",
] as const) {
  test(`Profile refuses ${defect} avatar metadata before binding`, async ({
    page,
  }) => {
    const api = await installProfileApi(page);
    api.fileShape = (file) => {
      if (defect === "creator") return { ...file, creator_id: profileUserB };
      if (defect === "purpose") return { ...file, purpose: "workspace_logo" };
      if (defect === "parent") return { ...file, record_id: profileUserB };
      if (defect === "size")
        return { ...file, expected_size: 2 * 1024 * 1024 + 1 };
      if (file.state !== "ready") return file;
      if (defect === "ready-state")
        return { ...file, state: "awaiting_upload" };
      if (defect === "actual-size") return { ...file, actual_size: null };
      return defect === "ready-mime"
        ? { ...file, media_type: "text/html" }
        : { ...file, id: profileUserB };
    };
    await page.goto("/profile");
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Maya Chen",
    );
    await page.getByLabel("Upload photo", { exact: true }).setInputFiles({
      name: "portrait.png",
      mimeType: "image/png",
      buffer: avatarPng,
    });
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /photo.*(invalid|not|could|unable|unavailable)/i }),
    ).toBeVisible();
    expect(
      api.writes.filter(({ path }) => path === "/api/auth/me/profile"),
    ).toEqual([]);
    expect(api.people.get(profileUserA)?.avatar_file_id).toBeNull();
  });
}

test("Profile explains committed avatar cleanup 503 and never reserves or binds again on reload", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  api.people.get(profileUserA)!.avatar_file_id = profileUserB;
  api.partialCleanup = true;
  await page.goto("/profile");
  await expect(
    page.getByRole("img", { name: "Your profile photo", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Upload photo", { exact: true }).setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: avatarPng,
  });
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /profile.*saved.*previous.*(delet|cleanup)/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Your profile photo", exact: true }),
  ).toBeVisible();
  expect(api.people.get(profileUserA)?.avatar_file_id).toBe(avatarFileId);
  const count = api.writes.length;
  await page
    .getByRole("button", { name: "Reload profile", exact: true })
    .click();
  await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
    "Maya Chen",
  );
  expect(api.writes).toHaveLength(count);
});

for (const fault of ["mime", "oversize", "headers"] as const) {
  test(`Profile refuses private avatar ${fault} delivery without clearing the saved binding`, async ({
    page,
  }) => {
    const api = await installProfileApi(page);
    api.people.get(profileUserA)!.avatar_file_id = avatarFileId;
    api.avatarFault = fault;
    await page.goto("/profile");
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Maya Chen",
    );
    await expect(
      page.getByRole("alert").filter({ hasText: /photo could not be loaded/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("img", { name: "Your profile photo", exact: true }),
    ).toHaveCount(0);
    expect(api.writes).toEqual([]);
    expect(api.people.get(profileUserA)?.avatar_file_id).toBe(avatarFileId);
    api.avatarFault = null;
    await page
      .getByRole("button", { name: "Reload profile", exact: true })
      .click();
    await expect(
      page.getByRole("img", { name: "Your profile photo", exact: true }),
    ).toBeVisible();
    expect(api.writes).toEqual([]);
  });
}

test("Profile avatar refusal rechecks once and stays usable until explicit reload", async ({
  page,
}) => {
  const api = await installProfileApi(page, { session: false });
  api.people.get(profileUserA)!.avatar_file_id = avatarFileId;
  const recheck = profileGate();
  let sessionChecks = 0;
  let refused = false;
  await page.route("**/api/auth/session", async (route) => {
    sessionChecks += 1;
    if (refused && sessionChecks === 1) {
      recheck.start();
      await recheck.waiting;
    }
    await route.fulfill({
      json: {
        authenticated: true,
        user_id: profileUserA,
        setup_required: false,
      },
    });
  });
  let reads = 0;
  await page.route(`**/api/users/${profileUserA}/avatar`, async (route) => {
    if (!refused) return route.fallback();
    reads += 1;
    const readNumber = reads;
    // Bound the broken implementation's loop without hiding the unwanted
    // third request: it settles visibly and fails the independent count.
    await route
      .fulfill({
        status: readNumber <= 2 ? 401 : 403,
        json: { detail: "Unavailable" },
      })
      .catch(() => {});
  });
  try {
    await page.goto("/profile");
    await expect(
      page.getByRole("img", { name: "Your profile photo", exact: true }),
    ).toBeVisible();
    refused = true;
    sessionChecks = 0;
    await page
      .getByRole("button", { name: "Reload profile", exact: true })
      .click();
    await recheck.begun;
    const alert = page
      .getByRole("alert")
      .filter({ hasText: /photo could not be loaded/i });
    recheck.release();
    await expect(alert).toBeVisible();
    await expect(page.getByLabel("Phone", { exact: true })).toBeEnabled();
    await page
      .getByLabel("Phone", { exact: true })
      .fill("Retained during refusal");
    expect(reads).toBe(1);
    expect(sessionChecks).toBe(1);
    expect(api.writes).toEqual([]);
    expect(api.people.get(profileUserA)?.avatar_file_id).toBe(avatarFileId);
    refused = false;
    await page
      .getByRole("button", { name: "Reload profile", exact: true })
      .click();
    await expect(
      page.getByRole("img", { name: "Your profile photo", exact: true }),
    ).toBeVisible();
    expect(api.writes).toEqual([]);
  } finally {
    recheck.release();
  }
});

test("Profile uncertain upload preserves the existing photo and text draft without reservation or binding replay", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  api.people.get(profileUserA)!.avatar_file_id = profileUserB;
  api.uploadStatus = 503;
  await page.goto("/profile");
  const photo = page.getByRole("img", {
    name: "Your profile photo",
    exact: true,
  });
  await expect(photo).toBeVisible();
  const priorUrl = await photo.getAttribute("src");
  await page
    .getByLabel("Phone", { exact: true })
    .fill("Retained with failed photo");
  await page.getByLabel("Upload photo", { exact: true }).setInputFiles({
    name: "portrait.png",
    mimeType: "image/png",
    buffer: avatarPng,
  });
  await expect(
    page.getByRole("alert").filter({ hasText: /photo.*outcome.*unavailable/i }),
  ).toBeVisible();
  await expect(photo).toHaveAttribute("src", priorUrl!);
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
    "Retained with failed photo",
  );
  await expect(page.getByLabel("Upload photo", { exact: true })).toBeDisabled();
  expect(api.writes.map(({ method, path }) => `${method} ${path}`)).toEqual([
    "POST /api/files",
    `PUT /api/files/${avatarFileId}/content`,
  ]);
  expect(api.people.get(profileUserA)?.avatar_file_id).toBe(profileUserB);
  api.uploadStatus = 200;
  await page
    .getByRole("button", { name: "Reload profile", exact: true })
    .click();
  await expect(page.getByLabel("Upload photo", { exact: true })).toBeEnabled();
  await expect(photo).toBeVisible();
  await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
    "Retained with failed photo",
  );
  expect(api.writes).toHaveLength(2);
  expect(api.people.get(profileUserA)?.avatar_file_id).toBe(profileUserB);
});

test("Profile revokes the old account photo URL and never binds a late old-account upload", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  api.people.get(profileUserA)!.avatar_file_id = profileUserB;
  const revoked = await observeProfilePhotoRevocations(page);
  await page.goto("/profile");
  const photo = page.getByRole("img", {
    name: "Your profile photo",
    exact: true,
  });
  await expect(photo).toBeVisible();
  const oldUrl = await photo.getAttribute("src");
  expect(oldUrl).toMatch(/^blob:/);
  const hold = profileGate();
  api.holdUpload = hold;
  try {
    await page.getByLabel("Upload photo", { exact: true }).setInputFiles({
      name: "portrait.png",
      mimeType: "image/png",
      buffer: avatarPng,
    });
    await hold.begun;
    await expect(
      page.getByLabel("Upload photo", { exact: true }),
    ).toBeDisabled();
    api.userId = profileUserB;
    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Second person",
    );
    await expect(photo).toHaveCount(0);
    await expect.poll(() => revoked).toContain(oldUrl);
    hold.release();
    await expect.poll(() => api.uploadCompletions).toBe(1);
    await expect(page.getByLabel("Display name", { exact: true })).toHaveValue(
      "Second person",
    );
    await expect(page.getByText("Profile saved.", { exact: true })).toHaveCount(
      0,
    );
    expect(
      api.writes.map(({ method, userId }) => ({ method, userId })),
    ).toEqual([
      { method: "POST", userId: profileUserA },
      { method: "PUT", userId: profileUserA },
    ]);
    expect(api.people.get(profileUserA)?.avatar_file_id).toBe(profileUserB);
    expect(api.people.get(profileUserB)?.avatar_file_id).toBeNull();
  } finally {
    hold.release();
  }
});

test("Profile unmount revokes its owned photo URL without clearing the saved identity", async ({
  page,
}) => {
  const api = await installProfileApi(page);
  api.people.get(profileUserA)!.avatar_file_id = avatarFileId;
  const revoked = await observeProfilePhotoRevocations(page);
  await page.goto("/profile");
  const photo = page.getByRole("img", {
    name: "Your profile photo",
    exact: true,
  });
  await expect(photo).toBeVisible();
  const photoUrl = await photo.getAttribute("src");
  expect(photoUrl).toMatch(/^blob:/);
  await page
    .getByRole("complementary", { name: "Primary sidebar", exact: true })
    .getByRole("link", { name: "OpenComms", exact: true })
    .click();
  await expect(page).toHaveURL(/\/comms$/);
  await expect.poll(() => revoked).toContain(photoUrl);
  expect(api.people.get(profileUserA)?.avatar_file_id).toBe(avatarFileId);
  expect(api.writes).toEqual([]);
});

test("Profile optional member MFA uses the incumbent enrollment verification and removal controller", async ({
  page,
}) => {
  const mfa = await mockMfa(page);
  await installProfileApi(page, { role: "member", session: false, mfa: false });
  try {
    await page.goto("/profile#security");
    await page
      .getByRole("button", {
        name: "Manage two-step verification",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Two-step verification",
      exact: true,
    });
    await dialog
      .getByRole("button", { name: "Set up authenticator", exact: true })
      .click();
    await expect(
      dialog.getByRole("heading", {
        name: "Verify your authenticator",
        exact: true,
      }),
    ).toBeVisible();
    await dialog
      .getByLabel("Verification code", { exact: true })
      .fill("123456");
    await dialog
      .getByRole("button", { name: "Verify code", exact: true })
      .click();
    await expect(
      dialog.getByRole("heading", {
        name: "Authenticator verified",
        exact: true,
      }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Remove authenticator", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Confirm removal", exact: true })
      .click();
    await expect(page).toHaveURL(/\/login$/);
    expect(mfa.actors.get(profileUserA)?.factors).toEqual([]);
    expect(
      mfa.calls
        .filter(({ method }) => method === "POST")
        .map(({ path }) => path),
    ).toEqual([
      "/auth/mfa/factors",
      "/auth/mfa/factors/00000000-0000-4000-8000-000000000601/verification",
    ]);
  } finally {
    await concealMfaTestCredentials(page);
  }
});

test("Profile optional MFA unavailable status retries honestly and cancel removes only owned unfinished setup", async ({
  page,
}) => {
  const mfa = await mockMfa(page);
  mfa.statusFailure = 503;
  await installProfileApi(page, { session: false, mfa: false });
  try {
    await page.goto("/profile#security");
    await page
      .getByRole("button", {
        name: "Manage two-step verification",
        exact: true,
      })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Two-step verification",
      exact: true,
    });
    await expect(dialog.getByRole("alert")).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Set up authenticator", exact: true }),
    ).toHaveCount(0);
    mfa.statusFailure = 0;
    await dialog.getByRole("button", { name: "Retry", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Set up authenticator", exact: true })
      .click();
    await expect(
      dialog.getByLabel("Verification code", { exact: true }),
    ).toBeVisible();
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(() => mfa.actors.get(profileUserA)?.factors.length)
      .toBe(0);
    expect(mfa.calls.filter(({ method }) => method === "DELETE")).toHaveLength(
      1,
    );
  } finally {
    await concealMfaTestCredentials(page);
  }
});

for (const [entry, destination] of [
  ["/settings/appearance", "/profile#look"],
  ["/platform?section=account", "/profile#security"],
  ["/platform#account", "/profile#security"],
] as const) {
  test(`Profile legacy entry ${entry} replaces to the correct section`, async ({
    page,
  }) => {
    await installProfileApi(page);
    await page.goto(entry);
    await expect(page).toHaveURL(
      new RegExp(`${destination.replace("#", "#")}$`),
    );
    await expect(
      page.getByRole("heading", { name: "Your profile", exact: true }),
    ).toBeVisible();
  });
}

test("Profile entry honors explicit Platform section precedence and Your profile navigation", async ({
  page,
}) => {
  await installProfileApi(page);
  await page.goto("/platform?section=search#account");
  await expect(
    page.getByRole("heading", { name: "Platform", exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/platform\?section=search#account$/);
  await expect(
    page
      .getByRole("navigation", { name: "Main navigation", exact: true })
      .getByRole("button", { name: "Platform", exact: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("link", { name: "Account", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page
    .getByRole("menuitem", { name: "Your profile", exact: true })
    .click();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(
    page.getByRole("navigation", { name: "Breadcrumb", exact: true }),
  ).toContainText("Profile");
  await expect(
    page.getByRole("button", { name: "Your profile", exact: true }).first(),
  ).toBeVisible();
});

test("Profile four captures: desktop and mobile in light and dark", async ({
  page,
}, testInfo) => {
  test.skip(
    process.env.CAPTURE_S21_PROFILE !== "1",
    "Opt-in rendered Profile acceptance record",
  );
  const api = await installProfileApi(page);
  api.patchStatus = 503;
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    for (const theme of ["light", "dark"] as const) {
      api.theme = theme;
      await page.setViewportSize(viewport);
      await page.goto("/profile");
      await expect(
        page.getByLabel("Display name", { exact: true }),
      ).toHaveValue("Maya Chen");
      await expect(
        page.getByLabel("Start page after sign-in", { exact: true }),
      ).toBeEnabled();
      await expect(
        page.getByRole("list", { name: "Active sessions", exact: true }),
      ).toContainText("Firefox on Android");
      await page
        .getByLabel("Phone", { exact: true })
        .fill("Retained phone draft");
      await page
        .getByRole("button", { name: "Save identity", exact: true })
        .click();
      await expect(
        page
          .getByRole("alert")
          .filter({ hasText: "Profile could not be saved" }),
      ).toBeVisible();
      await expect(page.getByLabel("Phone", { exact: true })).toHaveValue(
        "Retained phone draft",
      );
      await expect(page.locator("html")).toHaveClass(
        theme === "dark" ? /dark/ : /^(?!.*\bdark\b).*$/,
      );
      await expect(
        page.getByRole("region", { name: "Appearance preview", exact: true }),
      ).toContainText("Equipment request");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      // Only the developer overlay is suppressed, never product UI.
      await page.addStyleTag({
        content: "nextjs-portal { display: none !important; }",
      });
      const filename = `profile-${viewport.width}x${viewport.height}-${theme}.png`;
      await page.screenshot({
        path: testInfo.outputPath(filename),
        fullPage: true,
      });
      console.log(
        JSON.stringify({
          capture: filename,
          viewport,
          theme,
          page: await page.evaluate(() => ({
            width: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
          })),
        }),
      );
    }
  }
});
