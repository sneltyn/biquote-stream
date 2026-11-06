import { addAliases } from 'module-alias'

addAliases({
  '@apps': `${__dirname}/apps`,
  '@config': `${__dirname}/config`,
})
