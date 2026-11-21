
import type { ControlDatabase } from './database';
import { parseJsonStringArray } from './persistenceCodec';

export function assertWorkDependenciesCompleted(
  database: ControlDatabase,
  workItemId: string,
): void {
  const work = database.db
    .prepare(
      'SELECT depends_on_json FROM organization_work_items WHERE id = ?',
    )
    .get(workItemId) as
    | { depends_on_json: string }
    | undefined;

  if (!work) {
    throw new Error(`Task ${workItemId} not found`);
  }

  const dependencies = parseJsonStringArray(
    work.depends_on_json,
    'work item dependencies',
  );

  for (const dependencyId of dependencies) {
    const dependency = database.db
      .prepare(
        'SELECT status FROM organization_work_items WHERE id = ?',
      )
      .get(dependencyId) as
      | { status: string }
      | undefined;

    if (dependency?.status !== 'completed') {
      throw new Error(
        `Task ${workItemId} blocked by incomplete dependency ${dependencyId}`,
      );
    }
  }
}
