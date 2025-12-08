const { PrismaClient } = require('./apps/api/node_modules/@prisma/client');
const p=new PrismaClient();
(async()=>{
 const runs=await p.testRun.findMany({ orderBy:{createdAt:'desc'}, take:5, select:{id:true,status:true,summary:true,finishedAt:true}});
 console.log('runs',runs);
 const resultsCount=await p.testResult.count();
 console.log('results',resultsCount);
 await p.$disconnect();
})();
