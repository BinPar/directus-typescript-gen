#!/usr/bin/env node

import { promises } from "fs";
import { resolve } from "path";

import { camelCase } from "change-case";
import fetch from "node-fetch";
import { z } from "zod";
import yargs from "yargs";
import openApiTs, { OpenAPI3 } from "openapi-typescript";

const Argv = z.object({
  host: z.string(),
  email: z.string(),
  password: z.string(),
  typeName: z.string(),
  specOutFile: z.string().nullish(),
  outFile: z.string(),
});

type Argv = z.infer<typeof Argv>;

const main = async (): Promise<void> => {
  const argv = Argv.parse(
    await yargs(process.argv.slice(2))
      .option(`host`, { demandOption: true, type: `string` })
      .option(`email`, { demandOption: true, type: `string` })
      .option(`password`, { demandOption: true, type: `string` })
      .option(`typeName`, { demandOption: true, type: `string` })
      .option(`specOutFile`, { demandOption: false, type: `string` })
      .option(`outFile`, { demandOption: true, type: `string` })
      .help().argv,
  );

  const { host, email, password, typeName, specOutFile, outFile } = argv;

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

  const spec = await (
    await fetch(`${host}/server/specs/oas`, {
      method: `get`,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
  ).json();

  const collections = (await (
    await fetch(`${host}/collections`, {
      method: `get`,
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })
  ).json()) as { data: { collection: string }[] };

  const collectionsNames = new Map<string, string>(
    collections.data.map(({ collection }) => [
      collection.replace(/_/g, ``).toLowerCase(),
      collection,
    ]),
  );

  if (specOutFile) {
    await promises.writeFile(
      resolve(process.cwd(), specOutFile),
      JSON.stringify(spec, null, 2),
      {
        encoding: `utf-8`,
      },
    );
  }

  const baseSource = openApiTs(spec as OpenAPI3);

  const itemPattern = /^    Items([^\:]*)/;

  const interfacesToAvoid = new Set([`paths`, `operations`]);
  const lines = new Array<string>();
  let addLine = true;

  const exportProperties = baseSource
    .split(`\n`)
    .map((line) => {
      if (line.startsWith(`export interface`)) {
        const interfaceName = line.split(` `)[2];
        addLine = !interfacesToAvoid.has(interfaceName);
      }
      if (addLine) {
        lines.push(line);
      }
      const match = line.match(itemPattern);
      if (!match) {
        return null;
      }
      const [, collectionName] = match;
      const realCollectionName = collectionsNames.get(
        collectionName.toLowerCase(),
      );
      return `  ${
        realCollectionName || camelCase(collectionName)
      }: components["schemas"]["Items${collectionName}"];`;
    })
    .filter((line): line is string => typeof line === `string`);

  exportProperties.push(
    ...[
      `  directus_users: components["schemas"]["Users"];`,
      `  directus_roles: components["schemas"]["Roles"];`,
      `  directus_files: components["schemas"]["Files"];`,
      `  directus_folders: components["schemas"]["Folders"];`,
    ],
  );

  const exportSource = `export type ${typeName} = {\n${exportProperties.join(
    `\n`,
  )}\n};`;

  await promises.writeFile(
    resolve(process.cwd(), outFile),
    [...lines, exportSource].join(`\n`),
    {
      encoding: `utf-8`,
    },
  );
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  throw new Error(`This should be the main module.`);
}
