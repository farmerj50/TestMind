// Shared DTOs & types
export type ProjectDTO = { name: string; repoUrl: string };

export type Project = {
  id: string;
  name: string;
  repoUrl: string;
  ownerId: string; // Clerk user id
  createdAt: string;
};
