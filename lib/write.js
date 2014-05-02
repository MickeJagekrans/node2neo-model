'use strict';

var async = require('async');
var Node2NeoError = require('node2neo-schema').error;
var _ = require('lodash');



/**
 * Create a new node with the label defined in the model.
 * @param  {Object}   data     The data for the node
 * @param  {Object}   options  Optional. Include a transaction.
 * @param  {Function} callback
 * @return {Object}            Id, node and rel
 */
module.exports.create = function(data, options, callback){
  if(typeof options ==='function'){
    callback = options;
    options = {};
  }
  if(typeof data === 'function'){
    callback = data;
    return callback('Invalid create option. You must provide node details.');
  }

  var self = this;

  //test for indexes

  async.series({
    indexes: function(cb){
      if(self.schema._indexes.length > 0 || self.schema._constraints.length > 0){
        self.applyIndexes(cb);
      }
      else cb(null);
    },
    create: function(cb){

      data = self.schema.validate(data);
      if(data instanceof Error) return cb(data);

      var cypher, returnCypher, params = {};

      // pull out subschema elements and get separate cyphers
      var response = parseSubSchema(data, self.schema);
      data = response.data;


      cypher = 'CREATE (n:' + self.label + ' {props})';
      returnCypher = ' RETURN id(n), n';
      params.props = data;


      // do you want to create a relationship as part of the creation
      if(options.relationship){
        // turn single relationship into an array
        if(!Array.isArray(options.relationship)){
          options.relationship = [options.relationship];
        }

        var firstMatch = true, matchQuery = '', firstCondition = true, conditionQuery = '', createQuery = '';

        options.relationship.forEach(function(element, index){
          if(!element.direction || !element.type || !element.indexField ||
           (!element.indexValue && element.indexValue !== 0)  || !element.nodeLabel){
            return cb(new Node2NeoError('Create ' + self.label +': Invalid relationship details'));
          }

          // match the elements
          if(firstMatch) {
            matchQuery += 'MATCH ';
            firstMatch = false;
          }else {
            matchQuery += ', ';
          }
          matchQuery += '(relNode' + index + ':' + element.nodeLabel +')';

          //conditions
          if(firstCondition){
            conditionQuery = ' WHERE ';
            firstCondition = false;
          }
          else {
            conditionQuery +='AND ';
          }
          if(element.indexField === '_id') {
            conditionQuery += 'id(relNode' + index + ')={indexValue' + index + '} ';
          }
          else {
            conditionQuery += 'relNode' + index + '.' + element.indexField + '={indexValue' + index + '} ';
          }
          params['indexValue' + index] = element.indexValue;


          //create the relationship
          createQuery += ', n';
          if(element.direction === 'to') createQuery += '<';
          createQuery += '-[rel' + index + ':'+ element.type + ' {relData' + index + '}]-';
          if(element.direction === 'from') createQuery += '>';
          createQuery += 'relNode' + index;
          params['relData' + index] = element.data || {};

          //return the relationship information
          // returnCypher += ', type(rel), rel, id(rel)';

        });
        //insert the relationship information in front of the existing create cypher
        cypher = matchQuery + conditionQuery + cypher + createQuery;
      }

      //merge params from SubSchemas
      for(var atr in response.subSchemaParams){
        params[atr] = response.subSchemaParams[atr];
      }

      // convert the statement into the correct format
      var statement = {
        // statement : cypher + response.subSchemaCypher + returnCypher + response.subSchemaReturn,
        statement : cypher + response.subSchemaCypher + returnCypher,
        // statement : cypher + returnCypher,
        parameters: params
      };
      // console.log(statement.statement)

      if(options.transaction){

        options.transaction.exec(statement, function(err, response){
          if(err) return cb(err);
          else {
            var node = self.parseResults({results: response}, {limit: 1});

            // push events to the Transaction
            options.transaction._events.push({
              eventEmitter: self.schema,
              args: ['create', node]
            });

            return cb(null, node);
          }
        });
      }
      else{
        // if there is no transaction execute the statement
        self.db.beginTransaction({statements: [statement] }, {commit:true}, function(err, response){
          if(err) return cb(err);
          else {
            var node = self.parseResults(response, {limit: 1});
            self.schema.emit('create', node);

            //populated subschemas


            return cb(null, node);
          }
        });
      }
    }
  },
  function(err, result){
    if(err && options.transaction){
      options.transaction.remove(function(err2){
        return callback(err);
      });
    }
    else return callback(err, result.create);
  });
};


function createSchemaCypher(data, schema, count, relationship, parent, tag){
  var subSchemaCypher = '';
  var subSchemaReturn = '';
  var subSchemaParams = {};
  var subSchemaEvents = [];
  var response = [];
  var populatedSubSchemas = {};


  var populatedSchemas = _.intersection(Object.keys(schema._subSchemas), Object.keys(data));


  if(populatedSchemas.length > 0){
    populatedSchemas.forEach(function(element){
      // if(tag) populatedSubSchemas[tag][count][element] = [{}];
      // else populatedSubSchemas[element] = [{}];
      //separate out the sub schemas from the parent json
      var schemaData = _.cloneDeep(data[element]);

      delete data[element];

      var newParent = tag ? tag + '_' + parent + '_' + count: 'n';
      response.push(parseSubSchema(schemaData, schema._subSchemas[element].schema, schema._subSchemas[element].relationship, newParent, element));
    });
  }
  // populate the cypher - if there are any data left
  // remove nulls from data
  for(var key in data){
    if(data[key] === null ) {
      delete data[key];
    }
  }
  if(Object.keys(data).length > 0 && relationship){
    // if(schema._unique) subSchemaCypher += ' CREATE UNIQUE ';
    // else subSchemaCypher += ' CREATE ';
    subSchemaCypher += ', (' + tag + '_' + parent + '_' + count + ':' +
      schema.label + ' {element' + tag + parent + count + '})<-[:' +
      relationship + ']-(' + parent + ')';

    subSchemaParams['element' + tag + parent + count] = data;
    subSchemaReturn += ', id(' + tag + '_' + parent + '_' + count +'),' + tag + '_' + parent + '_' + count;
    // subSchemaEvents.push({eventEmitter: schema, args: data});
  }
  // merge the cypher from the subSchemas
  if(response.length > 0){
    response.forEach(function(element){
      // console.log(element)

      subSchemaCypher += element.subSchemaCypher;
      subSchemaReturn += element.subSchemaReturn;
      // subSchemaEvents = subSchemaEvents.concat(element.subSchemaEvents);
      for(var atr in element.subSchemaParams){
        subSchemaParams[atr] = element.subSchemaParams[atr];
      }
      for(var atr in element.populatedSubSchemas){
        populatedSubSchemas[atr] = element.populatedSubSchemas[atr];
      }
    });
  }
  //return the updated data and values
  return {subSchemaCypher: subSchemaCypher, subSchemaParams: subSchemaParams, subSchemaReturn: subSchemaReturn, subSchemaEvents: populatedSubSchemas};
}

function parseSubSchema(data, schema, relationship, parent, tag){
  // level = level || 0;
  var response = [], count = 0;

  //check if any of the fields are subschemas
  // data may be an array
  if(!Array.isArray(data)) data = [data];
  data.forEach(function(element){
    var createCypher, updateCypher;
    // separate between ones that need to be created and ones that need to be updated
    // if(element._id){
    //   //update this
    //   console.log('called')
    //   updateCypher = updateSchemaCypher(element, schema, count, relationship, parent, tag)
    // }
    // else {
      createCypher = createSchemaCypher(element, schema, count, relationship, parent, tag);
      response.push(createCypher);
    // }
    count++;
  });

  // merge the cypher from the subSchemas
  if(response.length && response.length > 0){
    var subSchemaCypher = '';
    var subSchemaReturn = '';
    var subSchemaParams = {};
    var populatedSubSchemas = [];

    response.forEach(function(element){
      subSchemaCypher += element.subSchemaCypher;
      subSchemaReturn += element.subSchemaReturn;
      for(var atr in element.subSchemaParams){
        subSchemaParams[atr] = element.subSchemaParams[atr];
      }

      for(var atr in element.populatedSubSchemas){
        populatedSubSchemas[atr] = element.populatedSubSchemas[atr];
      }
    });

    // data not needed as this is not the top level value
    response = {
      subSchemaCypher: subSchemaCypher,
      subSchemaReturn: subSchemaReturn,
      subSchemaParams: subSchemaParams,
      populatedSubSchemas: populatedSubSchemas
    };
  }

  // Confirm that the delete carries forward to this element - it should
  if(Array.isArray(response)){
    response = {};
  }
  response.data = data[0];

  return response;
}

/**
 * Update a model.
 *
 * PLEASE NOTE: You cannot create and update a model in the same transaction.
 *
 * @param  {Object}   node     Id and model of node to be updated
 * @param  {Object}   updates  The updates to be performed
 * @param  {Object}   options  Optional. Include a transaction
 * @param  {Function} callback
 * @return {Object}            Id and Node
 */
module.exports.update = function(node, updates, options, callback){
  if(typeof options ==='function'){
    callback = options;
    options = {};
  }
  if(typeof updates === 'function' || typeof updates !== 'object'){
    callback = updates;
    return callback(new Node2NeoError('Invalid update request. You must provide updates.'));
  }
  if(!node._id){
    return callback(new Node2NeoError('You must supply a node with an _id. See findByIdAndUpdate or findOneAndUpdate'));
  }
  var self = this;
  var id = node._id;
  delete node._id;

  for(var key in updates){
    node[key] = updates[key];
  }
  var originalNode = _.clone(node);


  var model = self.schema.validate(node);
  if(model instanceof Error) return callback(model);

  // set the initial params
  var params = {
    nodeId: id
  };

  // prepare the params for the updates and create the setQUeyr syntax
  var setQuery = '';
  var removeProperties = ' REMOVE';

  // all differences between node and model need to be added to updates
  for(var n in model){
    if(model[n] !== originalNode[n]){
      updates[n] = model[n];
    }
    if(model[n] === null){
      updates[n] = null;
    }
  }

  for(var key in updates){
    // if there is an existing value then setup the value for the event node

    // if the value of the field is to be set to a non null then setup the update and the event node
    if(model[key] !== null && typeof model[key] !== 'undefined'){
      params[key+'_NEW'] = model[key];
      setQuery += ' SET n.'+ key +' = {'+key+ '_NEW}';
    }
    // otherwise the value should be removed
    else if (model[key] === null){
      removeProperties += ' n.'+key+', ';

    }
  }
  // tidy up remove properties
  if(removeProperties === ' REMOVE') removeProperties = '';
  else removeProperties = removeProperties.slice(0, -2);

  var query = 'START n = node({nodeId})';

  query += setQuery;
  query += removeProperties;

  query += ' RETURN id(n), n';

  // push the statement to the
  var statement = {
    statement : query,
    parameters: params
  };

  if(options.transaction){

    options.transaction.exec(statement, function(err, response){
      if(err) {
        // close the transaction
        options.transaction.remove(function(err2){
          return callback(err);
        });
      }
      else {
        var node = self.parseResults({results: response}, {limit: 1});

        options.transaction._events.push({
          eventEmitter: self.schema,
          args: ['update', node, updates]
        });

        return callback(null, node);
      }
    });
  }
  else{
    // if there is no transaction execute the statement
    self.db.beginTransaction({statements: [statement] }, {commit:true}, function(err, response){
      if(err) return callback(err);

      var node = self.parseResults(response, {limit: 1});
      self.schema.emit('update', node, updates);
      return callback(null, node);
    });
  }
};

/**
 * Remove a node
 * @param  {Number}   id       The id of the node to be removed.
 * @param  {Object}   options  Optional. Transaction and Force
 *                             If a node has relationships you must set force to be true or it will fail.
 * @param  {Function} callback
 * @return {Null}
 */
module.exports.remove = function(id, options, callback){

  if (typeof(options) === 'function') {
    callback = options;
    options = {};
  }

  var params = {
    nodeId: parseInt(id, 10)
  };

  var query = 'START n = node({nodeId}) ';
  if(options.force) query += 'OPTIONAL MATCH n-[r]-() DELETE r,n';
  else query += 'DELETE n';

  // push the statement to the
  var statement = {
    statement : query,
    parameters: params
  };

  var self = this;
  if(options.transaction){
    options.transaction.exec(statement, function(err){
      if(err) {
        // close the transaction
        options.transaction.remove(function(err2){
          return callback(err);
        });
      }
      else{
        // push events to the Transaction
        options.transaction._events.push({
          eventEmitter: self.schema,
          args: ['remove', id]
        });

        return callback(null);
      }
    });
  }
  else{
    // if there is no transaction execute the statement
    self.db.beginTransaction({statements: [statement] }, {commit:true}, function(err){
      if(err) return callback(new Node2NeoError('Failed to delete node due to relationships. Try again with force: true option.'));
      else {
        self.schema.emit('remove', id);
        return callback(null);
      }
    });
  }
};

/**
 * Create a relationship
 *
 * Relationship contains:
 *   from: model or id
 *   to: model or id
 *   type: the type of relationship
 *   data: Optional data for the relationship
 *
 *
 * @param  {Object} relationship  The relationship object.
 * @param  {Object} options       Optional. Transaction
 * @param  {Function} callback
 * @return {Relationship}
 * @api    public
 */
module.exports.createRelationship = function(relationship, options, callback) {
  if(typeof relationship ==='function'){
    callback = relationship;
    return callback(new Node2NeoError('Invalid relationship creation request. Relationship details must be included.'));
  }

  if (typeof options === 'function') {
    callback = options;
    options= {};
  }

  if(!relationship.from || !relationship.to || !relationship.type){
    return callback(new Node2NeoError('Invalid relationship creation request. Relationship details must include from, to and type.'));
  }

  var query = 'START from=node({from}), to=node({to}) ' +
              'CREATE from-[rel:' + relationship.type + ' {data}]->to ' +
              'RETURN id(rel), type(rel), rel';

  // set the params object
  var params = relationship;
  delete params.type;
  if(!params.data) params.data = {};


  var statement = {
    statement: query,
    parameters: params
  };

  var self = this;
  if(options.transaction){
    options.transaction.exec(statement, function(err, response){
      if(err) {
        //close the transaction
        options.transaction.remove(function(){
          return callback(err);
        });
      }
      else {
        var rel = {
          _id: response[0].data[0].row[0],
          type: response[0].data[0].row[1],
          rel: response[0].data[0].row[2]
        };
        return callback(null, rel);
      }
    });
  }
  else{
    // if there is no transaction execute the statement
    self.db.beginTransaction({statements: [statement] }, {commit:true}, function(err, response){
      if(err) return callback(err);
      var rel = {
        _id: response.results[0].data[0].row[0],
        type: response.results[0].data[0].row[1],
        rel: response.results[0].data[0].row[2]
      };
      return callback(null, rel);
    });
  }
};

/**
 * Remove a relationship.
 *
 * Options include transaction
 *   options = { transaction: trans}
 *
 * @param  {Object}   relId     The id of the relationship
 * @param  {object}   options   OPtional. Transactions
 * @param  {Function} callback
 * @return {Null}
 * @api    public
 */
module.exports.removeRelationship = function(relId, options, callback) {
  if (typeof relationship === 'function') {
    callback = relationship;
    return callback(
      new Node2NeoError('Invalid remove relationship request. You need to supply a relationship id.'));
  }
  else if (typeof options ==='function'){
    callback = options;
    options = {};
  }

  var params = {
    relId: relId
  };

  var query = 'START rel = relationship({relId}) DELETE rel';

  var statement = {
    statement: query,
    parameters: params
  };

  var self = this;
  if(options.transaction){
    options.transaction.exec(statement, function(err){
      if(err) {
        //close the transaction
        options.transaction.remove(function(){
          return callback(err);
        });
      }
      else {
        return callback(null);
      }
    });
  }
  else{
    // if there is no transaction execute the statement
    self.db.beginTransaction({statements: [statement] }, {commit:true}, callback);
  }
};
