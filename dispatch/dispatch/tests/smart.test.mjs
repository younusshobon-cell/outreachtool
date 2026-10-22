import {test} from 'node:test';import assert from 'node:assert/strict';import {personalise,inspectCopy,spinText} from '../src/util.js';
test('message variations are stable per recipient and preserve personalization fallbacks',()=>{
 const text='[[Hi|Hello|Hey]] {{first_name|there}}, {{business}}';const biz={email:'a@example.com',name:'Acme'};
 const result=personalise(text,biz);assert.match(result,/^(Hi|Hello|Hey) there, Acme$/);assert.equal(result,personalise(text,biz));
 const variants=new Set(Array.from({length:30},(_,i)=>spinText('[[Hi|Hello|Hey]]',i+'@example.com')));assert.equal(variants.size,3);
 assert.equal(personalise('{{business}}',{name:'[[Do not|spin imported data]]'}),'[[Do not|spin imported data]]');
});
test('copy checks distinguish missing values, fallbacks and malformed variations',()=>{
 assert.deepEqual(inspectCopy('Hello {{first_name}}','Text',{}).missing,['first_name']);
 assert.deepEqual(inspectCopy('Hello {{first_name|there}}','Text',{}).missing,[]);
 assert(inspectCopy('Hi','[[Hi|]]',{}).warnings.some(w=>w.startsWith('Check variation')));
 assert(inspectCopy('x'.repeat(80),'word '.repeat(181),{}).warnings.length>=2);
 assert.equal(personalise('{{constructor}}',{}),'');
});
