import {
  collection,
  doc,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
  type SnapshotOptions,
} from "firebase/firestore";

import { getDb } from "../firebase.ts";

/**
 * Build a typed Firestore data converter. Strips the `id` field on the
 * write path (we only ever persist it as the document id) and injects
 * `snapshot.id` on the read path.
 */
export function makeConverter<T extends { id: string }>(): FirestoreDataConverter<T> {
  return {
    toFirestore(value) {
      const { id: _id, ...rest } = value;
      return rest as DocumentData;
    },
    fromFirestore(
      snapshot: QueryDocumentSnapshot,
      options?: SnapshotOptions,
    ): T {
      const data = snapshot.data(options) as Omit<T, "id">;
      return { ...(data as T), id: snapshot.id };
    },
  };
}

/**
 * Typed collection reference. Use this from service modules instead of
 * calling `collection(db, ...)` directly so every access to the
 * collection goes through the same converter.
 */
export function typedCollection<T extends { id: string }>(
  path: string,
): CollectionReference<T> {
  return collection(getDb(), path).withConverter(
    makeConverter<T>(),
  ) as CollectionReference<T>;
}

/**
 * Typed document reference backed by the same converter.
 */
export function typedDoc<T extends { id: string }>(
  path: string,
  id: string,
): DocumentReference<T> {
  return doc(getDb(), path, id).withConverter(
    makeConverter<T>(),
  ) as DocumentReference<T>;
}
