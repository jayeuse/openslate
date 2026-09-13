export type Announcement = {
  id: string;
  title: string;
  body: string;
  audience: string;
  expires: string;
  pinned: boolean;
};

export const initialAnnouncements: Announcement[] = [
  {
    id: "sample-announcement-welcome",
    title: "A clearer week starts here.",
    body: "Use this board to keep everyone aligned on priorities, upcoming work, and important changes.",
    audience: "Everyone",
    expires: "",
    pinned: true,
  },
];
