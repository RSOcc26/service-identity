import pg from 'pg';

export const createPool = () => new pg.Pool({ connectionString: process.env.DATABASE_URL });
