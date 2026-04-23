import { getDoc, getDocs, query, setDoc } from "firebase/firestore";

import type { Company, Interaction, Person } from "../types/crm.ts";

import { getOwnerUidOrThrow, ownerScope } from "./auth.ts";
import { typedCollection, typedDoc } from "./firestore.ts";

const PEOPLE = "people";
const COMPANIES = "companies";
const INTERACTIONS = "interactions";

export async function listPeople(): Promise<Person[]> {
  const snap = await getDocs(
    query(typedCollection<Person>(PEOPLE), ...ownerScope()),
  );
  return snap.docs.map((d) => d.data());
}

export async function getPerson(id: string): Promise<Person | undefined> {
  const snap = await getDoc(typedDoc<Person>(PEOPLE, id));
  return snap.exists() ? snap.data() : undefined;
}

/** See `upsertExperienceUnit` for the owner_uid-stamping rationale. */
export async function upsertPerson(
  person: Omit<Person, "owner_uid">,
): Promise<void> {
  await setDoc(
    typedDoc<Person>(PEOPLE, person.id),
    { ...person, owner_uid: getOwnerUidOrThrow() },
    { merge: true },
  );
}

export async function listCompanies(): Promise<Company[]> {
  const snap = await getDocs(
    query(typedCollection<Company>(COMPANIES), ...ownerScope()),
  );
  return snap.docs.map((d) => d.data());
}

export async function getCompany(id: string): Promise<Company | undefined> {
  const snap = await getDoc(typedDoc<Company>(COMPANIES, id));
  return snap.exists() ? snap.data() : undefined;
}

/** See `upsertExperienceUnit` for the owner_uid-stamping rationale. */
export async function upsertCompany(
  company: Omit<Company, "owner_uid">,
): Promise<void> {
  await setDoc(
    typedDoc<Company>(COMPANIES, company.id),
    { ...company, owner_uid: getOwnerUidOrThrow() },
    { merge: true },
  );
}

export async function listInteractions(): Promise<Interaction[]> {
  const snap = await getDocs(
    query(typedCollection<Interaction>(INTERACTIONS), ...ownerScope()),
  );
  return snap.docs.map((d) => d.data());
}

/** See `upsertExperienceUnit` for the owner_uid-stamping rationale. */
export async function upsertInteraction(
  interaction: Omit<Interaction, "owner_uid">,
): Promise<void> {
  await setDoc(
    typedDoc<Interaction>(INTERACTIONS, interaction.id),
    { ...interaction, owner_uid: getOwnerUidOrThrow() },
    { merge: true },
  );
}
