const assert = require('node:assert/strict');

const test = require('node:test');
const { mysql, postgres } = require('..');
const knex = require('knex');

for (const [dialect, client] of Object.entries({ mysql, postgres })) {
  test(`${dialect}: destroy before configuring a connection`, async () => {
    await knex({ client }).destroy();
  });

  test(`${dialect}: reuse one SDK client without sharing transaction state`, async () => {
    const clients = [];
    const statements = [];
    const committed = [];
    let transactionCount = 0;
    let destroyed = 0;

    class RDSDataService {
      constructor() {
        clients.push(this);
      }

      async executeStatement(statement) {
        statements.push(statement);
        return {
          columnMetadata: [{ name: 'value', typeName: 'BIGINT' }],
          records: [[{ longValue: 1 }]],
        };
      }

      async beginTransaction() {
        transactionCount += 1;
        return { transactionId: `transaction-${transactionCount}` };
      }

      async commitTransaction({ transactionId }) {
        committed.push(transactionId);
        return {};
      }

      destroy() {
        destroyed += 1;
      }
    }

    const database = knex({
      client,
      connection: {
        AWS: { RDSDataService },
        database: 'test',
        resourceArn: 'test-resource',
        secretArn: 'test-secret',
      },
    });

    try {
      await Promise.all(
        Array.from({ length: 100 }, () => database.raw('select 1 as value')),
      );
      await Promise.all([
        database.transaction(async (transaction) => {
          await transaction.raw('select 1 as first_transaction');
          await database.raw('select 1 as outside_transaction');
          await transaction.raw('select 1 as first_transaction_again');
        }),
        database.transaction(async (transaction) => {
          await transaction.raw('select 1 as second_transaction');
        }),
      ]);

      assert.equal(clients.length, 1);
      assert.equal(statements.length, 104);
      const transactionFor = (sql) =>
        statements.find((statement) => statement.sql === sql).transactionId;
      assert.equal(
        transactionFor('select 1 as outside_transaction'),
        undefined,
      );
      assert.equal(
        transactionFor('select 1 as first_transaction'),
        transactionFor('select 1 as first_transaction_again'),
      );
      assert.notEqual(
        transactionFor('select 1 as first_transaction'),
        transactionFor('select 1 as second_transaction'),
      );
      assert.deepEqual(committed.sort(), ['transaction-1', 'transaction-2']);
    } finally {
      await database.destroy();
    }
    assert.equal(destroyed, 1);
  });
}
