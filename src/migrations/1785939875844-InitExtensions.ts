import { MigrationInterface, QueryRunner } from "typeorm";

export class InitExtensions1785939875844 implements MigrationInterface {

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query('CREATE EXTENSION IF NOT EXISTS postgis;')
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
         // Расширение намеренно не удаляем: от postgis зависят postgis_topology
    }

}
