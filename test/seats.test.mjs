import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Seats } from '../server/seats.mjs';

test('the newest screen takes the seat; the one it replaced cannot free it by leaving', () => {
    const seats = new Seats();
    assert.equal(seats.take('demo', 'phone'), undefined);
    assert.equal(seats.take('demo', 'tablet'), 'phone');
    seats.leave('demo', 'phone');
    assert.equal(seats.holder('demo'), 'tablet');
    seats.leave('demo', 'tablet');
    assert.equal(seats.holder('demo'), undefined);
    assert.equal(seats.take('other', 'phone'), undefined, 'conversations do not share a seat');
});
