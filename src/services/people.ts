import { getDoc, getDocs, query, setDoc } from "firebase/firestore";

import type { Company, Interaction, Person } from "../types/crm.ts";

import { ownerScope } from "./auth.ts";
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

export async function upsertPerson(person: Person): Promise<void> {
  await setDoc(typedDoc<Person>(PEOPLE, person.id), person, { merge: true });
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

export async function upsertCompany(company: Company): Promise<void> {
  await setDoc(typedDoc<Company>(COMPANIES, company.id), company, {
    merge: true,
  });
}

export async function listInteractions(): Promise<Interaction[]> {
  const snap = await getDocs(
    query(typedCollection<Interaction>(INTERACTIONS), ...ownerScope()),
  );
  return snap.docs.map((d) => d.data());
}

export async function upsertInteraction(
  interaction: Interaction,
): Promise<void> {
  await setDoc(
    typedDoc<Interaction>(INTERACTIONS, interaction.id),
    interaction,
    { merge: true },
  );
}
