#!/usr/bin/env node

import { writeFile } from "fs/promises";
import { resolve } from "path";

import fetch, { RequestInit } from "node-fetch";
import { z } from "zod";
import yargs from "yargs";
import { pascalCase } from "change-case";

const Argv = z.object({
  host: z.string().default(`http://0.0.0.0:8055`),
  email: z.string(),
  password: z.string(),
  typeName: z.string().default(`DirectusTypes`),
  outFile: z.string().default(`directus.ts`),
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
  required: boolean;
  schema?: {
    is_nullable: boolean;
    is_primary_key: boolean;
    foreign_key_table?: string | null;
  };
  meta?: {
    options?: {
      choices?: {
        value: string;
      }[];
    };
    special?: string[];
    interface?: string;
  };
}

interface CollectionInfo {
  collection: string;
  meta: {
    translations?: {
      language: string;
      translation: string;
    }[];
  };
}

const types = new Map<string, string>([
  [`string`, `string`],
  [`uuid`, `string`],
  [`timestamp`, `string`],
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

const fieldsToAvoidChoices = new Set<string>([`auth_password_policy`]);
const multipleSpecial = new Set<string>([`o2m`, `m2m`]);
const singleSpecial = new Set<string>([`m2o`, `file`]);

const getTypes = (
  field: string,
  directusType: string,
  meta?: FieldInfo[`meta`],
): string[] => {
  const res = new Array<string>();

  if (directusType === `json` && meta?.interface === `tags`) {
    res.push(`string[]`);
  } else {
    const type = types.get(directusType);
    if (
      !fieldsToAvoidChoices.has(field) &&
      directusType !== `json` &&
      meta?.options?.choices?.length
    ) {
      meta?.options.choices.forEach((choice) => {
        const surrounding = type !== `number` ? `'` : ``;
        res.push(`${surrounding}${choice.value}${surrounding}`);
      });
    } else {
      if (type) {
        res.push(type);
      } else {
        console.error(`Type ${directusType} missing`);
      }
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
  return `${res.length > 1 ? `(` : ``}${res.map((r) => `${r}`).join(` | `)}${
    res.length > 1 ? `)` : ``
  }${relation?.multiple ? `[]` : ``}${
    nullable && !relation?.multiple ? ` | null` : ``
  }`;
};

const main = async (): Promise<void> => {
  const argv = Argv.parse(
    await yargs(process.argv.slice(2))
      .option(`host`, { type: `string` })
      .option(`email`, { demandOption: true, type: `string` })
      .option(`password`, { demandOption: true, type: `string` })
      .option(`typeName`, { type: `string` })
      .option(`outFile`, { type: `string` })
      .help().argv,
  );

  const { host, email, password, typeName, outFile } = argv;

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

  console.log({ token });

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
        relation.meta.one_field
      ) {
        relatedCollectionByKey.set(
          `${relation.meta.one_collection}|${relation.meta.one_field}`,
          relation.collection,
        );
      }
    }
  }

  const collectionIdType = new Map<string, string>();
  const collectionsMap = new Map<string, Collection>();

  for (let i = 0, l = fields.length; i < l; i++) {
    const fieldInfo = fields[i];

    const avoid =
      fieldInfo.type === `alias` &&
      fieldInfo.meta?.special?.some((s) => s === `group` || s === `no-data`);

    if (!avoid) {
      if (fieldInfo.field === `id`) {
        const type = types.get(fieldInfo.type);
        if (type) {
          collectionIdType.set(fieldInfo.collection, type);
        } else {
          console.error(`Missing type for ${fieldInfo.type}`);
        }
      }
      let collection = collectionsMap.get(fieldInfo.collection);
      if (!collection) {
        const collectionInfo = collectionsInfo.get(fieldInfo.collection);
        const translation = collectionInfo?.meta.translations?.find((t) =>
          t.language.toLowerCase().startsWith(`en`),
        );
        const key = pascalCase(
          translation?.translation || fieldInfo.collection,
        );
        collection = {
          table: fieldInfo.collection,
          key,
          fields: new Array<Field>(),
        };
        collectionsMap.set(fieldInfo.collection, collection);
      }

      const field: Field = {
        key: fieldInfo.field,
        posibleTypes: new Array<string>(),
        required: !!fieldInfo.required,
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

      if (
        fieldInfo.schema?.foreign_key_table &&
        fieldInfo.meta?.special?.some((s) => singleSpecial.has(s))
      ) {
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

      collection.fields.push(field);
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
        `  ${field.key}${field.required ? `` : `?`}: ${getTypesText(
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
    const { key, table } = collectionsData[i];
    lines.push(`  ${table}: ${key};`);
  }
  lines.push(`};\n`);

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
