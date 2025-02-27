#!/usr/bin/env node

import { writeFile } from "fs/promises";
import { resolve } from "path";

import fetch, { RequestInit } from "node-fetch";
import { z } from "zod";
import yargs from "yargs";
import { pascalCase } from "change-case";
import { singular } from "pluralize";

const Argv = z.object({
  host: z.string().default(`http://0.0.0.0:8055`),
  email: z.string(),
  password: z.string(),
  typeName: z.string().default(`DirectusTypes`),
  outFile: z.string().default(`directus.ts`),
  legacy: z.boolean().nullish(),
  newTypes: z.boolean().nullish(),
});

type Argv = z.infer<typeof Argv>;

interface Field {
  key: string;
  required?: boolean;
  nullable?: boolean;
  posibleTypes: string[];
  relation?: {
    table: string;
    multiple?: boolean;
    isM2M?: boolean;
  };
}

interface Collection {
  table: string;
  key: string;
  fields: Field[];
  singleton: boolean;
}

interface Relation {
  collection: string;
  field: string;
  related_collection: string;
  meta?: {
    many_collection?: string;
    many_field?: string;
    one_collection?: string;
    one_field?: string;
  };
}

interface FieldInfo {
  collection: string;
  field: string;
  type: string;
  schema?: {
    is_nullable: boolean;
    is_primary_key: boolean;
    foreign_key_table?: string | null;
  };
  meta?: {
    options?: {
      choices?: (
        | string
        | {
            value: string;
          }
      )[];
      fields?: {
        field: string;
        type: string;
        meta?: {
          required?: boolean;
        };
      }[];
    };
    special?: string[];
    interface?: string;
    required: boolean;
  };
}

interface CollectionInfo {
  collection: string;
  meta?: {
    singleton: boolean;
  };
}

const types = new Map<string, string>([
  [`string`, `string`],
  [`uuid`, `string`],
  [`timestamp`, `string`],
  [`time`, `string`],
  [`dateTime`, `string`],
  [`date`, `string`],
  [`integer`, `number`],
  [`boolean`, `boolean`],
  [`text`, `string`],
  [`json`, `string`],
  [`alias`, `number`],
  [`csv`, `string`],
  [`bigInteger`, `number`],
  [`hash`, `string`],
  [`float`, `number`],
]);

const newTypes = new Map<string, string>([
  [`string`, `string`],
  [`uuid`, `string`],
  [`time`, `string`],
  [`timestamp`, `'datetime'`],
  [`dateTime`, `'datetime'`],
  [`date`, `'datetime'`],
  [`integer`, `number`],
  [`boolean`, `boolean`],
  [`text`, `string`],
  [`json`, `'json'`],
  [`alias`, `number`],
  [`csv`, `'csv'`],
  [`bigInteger`, `number`],
  [`hash`, `string`],
  [`float`, `number`],
]);

const fieldsToAvoidChoices = new Set<string>([`auth_password_policy`]);
const multipleSpecial = new Set<string>([
  `o2m`,
  `m2m`,
  `translations`,
  `files`,
]);

// const stringArrayInterfaces = new Set<string>([
//   `tags`,
//   `select-multiple-checkbox`,
//   `select-multiple-checkbox-tree`,
//   `directus-book-spine-checkbox-tree`,
// ]);

let useNewTypes = false;

const getTypes = (
  field: string,
  directusType: string,
  meta?: FieldInfo[`meta`],
): string[] => {
  const res = new Array<string>();

  const typesMap = useNewTypes ? newTypes : types;
  const type = typesMap.get(directusType);

  if (
    !fieldsToAvoidChoices.has(field) &&
    directusType !== `json` &&
    meta?.options?.choices?.length
  ) {
    meta?.options.choices.forEach((choice) => {
      const surrounding = type !== `number` ? `'` : ``;
      const choiceText = typeof choice === `string` ? choice : choice.value;
      res.push(`${surrounding}${choiceText}${surrounding}`);
    });
  } else if (
    !fieldsToAvoidChoices.has(field) &&
    directusType === `json` &&
    meta?.options?.fields?.length
  ) {
    res.push(`{
  ${meta.options.fields
    .filter((item) => typesMap.has(item.type))
    .map(
      (item) =>
        `${item.field}${item.meta?.required ? `` : `?`}: ${typesMap.get(
          item.type,
        )};`,
    )
    .join(`\n    `)}
}[]`);
    if (type) {
      res.push(type);
    }
  } else {
    if (type) {
      res.push(type);
    } else {
      console.error(`Type ${directusType} missing`);
      res.push(`unknown`);
    }
  }

  return res;
};

const getTypesText = (
  fieldTypes: string[],
  collectionsMap: Map<string, Collection>,
  collectionIdType: Map<string, string>,
  nullable?: boolean,
  relation?: Field[`relation`],
): string => {
  const res = new Array<string>(...fieldTypes);
  if (relation) {
    const collection = collectionsMap.get(relation.table);
    if (collection) {
      const type = collectionIdType.get(relation.table);
      if (type) {
        res.push(type);
      }
      res.push(collection.key);
    } else {
      console.error(`Collection not found for table ${relation.table}`);
    }
  }
  const addNull = nullable && !relation?.multiple;
  const multipleTypes = res.length > 1;
  return `${multipleTypes && addNull ? `(` : ``}${res
    .map(
      (r) =>
        `${r}${multipleTypes && !addNull && relation?.multiple ? `[]` : ``}`,
    )
    .join(` | `)}${multipleTypes && addNull ? `)` : ``}${
    !(multipleTypes && !addNull) && relation?.multiple ? `[]` : ``
  }${addNull ? ` | null` : ``}`;
};

const main = async (): Promise<void> => {
  const argv = Argv.parse(
    await yargs(process.argv.slice(2))
      .option(`host`, { type: `string` })
      .option(`email`, { demandOption: true, type: `string` })
      .option(`password`, { demandOption: true, type: `string` })
      .option(`legacy`, { type: `boolean` })
      .option(`newTypes`, { type: `boolean` })
      .option(`typeName`, { type: `string` })
      .option(`outFile`, { type: `string` })
      .help().argv,
  );

  const { host, email, password, typeName, outFile, legacy } = argv;

  useNewTypes = !!argv.newTypes;

  const typesMap = useNewTypes ? newTypes : types;

  const {
    data: { access_token: token },
  } = await (
    await fetch(new URL(`/auth/login`, host).href, {
      method: `post`,
      body: JSON.stringify({ email, password, mode: `json` }),
      headers: {
        "Content-Type": `application/json`,
      },
    })
  ).json();

  const headers: RequestInit[`headers`] = {
    Authorization: `Bearer ${token}`,
  };

  const { data: collections } = await fetch(new URL(`/collections`, host), {
    method: `get`,
    headers,
  }).then((res) => res.json() as Promise<{ data: CollectionInfo[] }>);

  const collectionsInfo = new Map<string, CollectionInfo>(
    collections.map((col) => [col.collection, col]),
  );

  const { data: fields } = await fetch(new URL(`/fields`, host), {
    method: `get`,
    headers,
  }).then((res) => res.json() as Promise<{ data: FieldInfo[] }>);

  const { data: relations } = await fetch(new URL(`/relations`, host), {
    method: `get`,
    headers,
  }).then((res) => res.json() as Promise<{ data: Relation[] }>);

  const relatedCollectionByKey = new Map<string, string>();

  for (let i = 0, l = relations.length; i < l; i++) {
    const relation = relations[i];
    if (relation.meta) {
      if (
        relation.meta.many_collection === relation.collection &&
        relation.meta.one_collection &&
        (relation.meta.one_field || relation.meta.many_field)
      ) {
        relatedCollectionByKey.set(
          `${relation.meta.one_collection}|${
            relation.meta.one_field || relation.meta.many_field
          }`,
          relation.collection,
        );
      }
    }
  }

  const collectionIdType = new Map<string, string>();
  const collectionsMap = new Map<string, Collection>();
  const collectionsByKey = new Map<string, Collection[]>();
  const duplicatedCollectionKeys = new Set<string>();

  for (let i = 0, l = fields.length; i < l; i++) {
    const fieldInfo = fields[i];

    const avoid =
      fieldInfo.type === `alias` &&
      fieldInfo.meta?.special?.some((s) => s === `group` || s === `no-data`);

    if (!avoid) {
      if (fieldInfo.schema?.is_primary_key) {
        const type = typesMap.get(fieldInfo.type);
        if (type) {
          collectionIdType.set(fieldInfo.collection, type);
        } else {
          console.error(`Missing type for ${fieldInfo.type}`);
        }
      }

      let collection = collectionsMap.get(fieldInfo.collection);
      if (!collection) {
        const collectionInfo = collectionsInfo.get(fieldInfo.collection);
        if (collectionInfo && !collectionInfo.meta) {
          continue;
        }
        const key = pascalCase(singular(fieldInfo.collection));
        const singleton = !!collectionInfo?.meta?.singleton;
        collection = {
          table: fieldInfo.collection,
          key: singleton ? key : singular(key),
          fields: new Array<Field>(),
          singleton,
        };
        collectionsMap.set(fieldInfo.collection, collection);
        collectionsByKey.set(key, [
          ...(collectionsByKey.get(key) || []),
          collection,
        ]);
        if ((collectionsByKey.get(key)?.length ?? 0) > 1) {
          duplicatedCollectionKeys.add(key);
        }
      }

      const field: Field = {
        key: fieldInfo.field,
        posibleTypes: new Array<string>(),
        required: !!fieldInfo.meta?.required,
        nullable:
          fieldInfo.schema?.is_nullable && !fieldInfo.schema?.is_primary_key,
      };

      if (
        fieldInfo.type === `alias` &&
        fieldInfo.meta?.special?.some((s) => multipleSpecial.has(s))
      ) {
        const table = relatedCollectionByKey.get(
          `${fieldInfo.collection}|${fieldInfo.field}`,
        );
        if (table) {
          field.relation = {
            table,
            multiple: true,
            isM2M: fieldInfo.meta.special.some((s) => s === `m2m`),
          };
        } else {
          console.error(
            `Table not found for relation ${fieldInfo.field} (${fieldInfo.collection})`,
          );
        }
      }

      if (fieldInfo.schema?.foreign_key_table) {
        field.relation = {
          table: fieldInfo.schema?.foreign_key_table,
        };
      }

      if (!field.relation) {
        field.posibleTypes = getTypes(
          fieldInfo.field,
          fieldInfo.type,
          fieldInfo.meta,
        );
      }

      if (
        fieldInfo.field === `avatar` &&
        fieldInfo.collection === `directus_users`
      ) {
        field.posibleTypes.push(`DirectusFile`);
      }

      collection.fields.push(field);
    }
  }

  const duplicatedKeys = Array.from(duplicatedCollectionKeys);
  for (let i = 0, l = duplicatedKeys.length; i < l; i++) {
    const key = duplicatedKeys[i];
    if (key) {
      const collections = collectionsByKey.get(duplicatedKeys[i]);
      if (collections?.length) {
        const lowerKey = key.toLowerCase();
        collections.sort((a, b) => {
          if (a.table.length > b.table.length) {
            return 1;
          }
          if (a.table.length < b.table.length) {
            return -1;
          }
          return 0;
        });
        const bestMatch =
          collections.find((col) => col.table.toLowerCase() === lowerKey) ||
          collections.find((col) =>
            col.table.toLowerCase().startsWith(lowerKey),
          ) ||
          collections[0];
        if (!bestMatch) {
          throw Error(
            `No best match for key ${key} and collections ${collections
              .map((col) => col.table)
              .join(`, `)}`,
          );
        }
        for (let j = 0, k = collections.length; j < k; j++) {
          const collection = collections[j];
          if (collection) {
            if (collection.table === bestMatch.table) {
              collection.key = key;
            } else {
              collection.key = pascalCase(collection.table);
              if (!collection.singleton) {
                collection.key = singular(collection.key);
              }
            }
          }
        }
      }
    }
  }

  const lines = new Array<string>();
  lines.push(
    `/* eslint-disable @typescript-eslint/consistent-type-definitions */\n`,
  );

  const collectionsData = Array.from(collectionsMap.values());

  for (let i = 0, l = collectionsData.length; i < l; i++) {
    const collectionData = collectionsData[i];
    lines.push(`export type ${collectionData.key} = {`);
    collectionData.fields.forEach((field) => {
      lines.push(
        `  ${field.key}${
          field.required || field.key === `id` ? `` : `?`
        }: ${getTypesText(
          field.posibleTypes,
          collectionsMap,
          collectionIdType,
          field.nullable,
          field.relation,
        )};`,
      );
    });
    lines.push(`};\n`);
  }

  lines.push(`export type ${typeName} = {`);
  for (let i = 0, l = collectionsData.length; i < l; i++) {
    const { key, table, singleton } = collectionsData[i];
    lines.push(`  ${table}: ${key}${!legacy && !singleton ? `[]` : ``};`);
  }
  lines.push(`};\n`);

  if (!legacy) {
    lines.push(`export enum CollectionNames {`);
    for (let i = 0, l = collectionsData.length; i < l; i++) {
      const { table } = collectionsData[i];
      lines.push(`  ${table} = '${table}'${i !== l - 1 ? `,` : ``}`);
    }
    lines.push(`}\n`);
  }

  if (useNewTypes) {
    lines.push(`
type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonPrimitive[] | { [key: string]: JsonValue };

type TypesMap = {
  json: JsonValue;
  csv: string;
  datetime: string;
};

export type DirectusToPrimitive<
  Item extends Record<string, unknown>,
> = {
  [F in keyof Item]: Extract<Item[F], keyof TypesMap> extends infer A
      ? A[] extends never[]
        ? Item[F]
        : A extends keyof TypesMap
          ? TypesMap[A] | Exclude<Item[F], A>
          : Item[F]
      : Item[F];
};
`);
  }

  await writeFile(resolve(process.cwd(), outFile), lines.join(`\n`), {
    encoding: `utf-8`,
  });
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  throw new Error(`This should be the main module.`);
}
