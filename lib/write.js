'use strict';

var async = require('async');
var Node2NeoError = require('node2neo-schema').error;



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
      self.schema.validate(data, function(err, data){
        if(err) return cb(err);

        var cypher, relationshipCypher, returnCypher, params = {};

        cypher = 'CREATE (n:' + self.label + ' {props})';
        returnCypher = ' RETURN id(n), n';
        params.props = data;


        // do you want to create a relationship as part of the creation
        if(options.relationship){
          if(!options.relationship.direction || !options.relationship.type || !options.relationship.indexField ||
           !options.relationship.indexValue  || !options.relationship.nodeLabel){
            return cb(new Node2NeoError('Create ' + self.label +': Invalid relationship details'));
          }

          //relationship is valid so setup some parameters
          params.indexValue = options.relationship.indexValue;


          // Lookup logic - Relationship (based on _id) and EventNodes, if requested
          // Need to lookup starting nodes if the relationship requested has an indexField of _id
          // Need to lookup user if evtNodes user is specified
          // Need to lookup LATEST EVENT for user and/or relationshipNode if eventNodes requested
          // e.g options: {eventNodes:{user:true, relationshipNode:true}}
          if(options.relationship.indexField === '_id') {
            relationshipCypher = 'START relNode=node({indexValue}) ';
          }
          else {
            relationshipCypher += 'MATCH relNode:' + options.relationship.nodeLabel +' WHERE relNode.' +
              options.relationship.indexField + '={indexValue} ';
          }

          //insert the relationship information in front of the existing create cypher
          cypher = relationshipCypher + cypher;

          //add the relationship creation information to the cypher
          if(options.relationship.direction === 'to') cypher += '<';
          cypher += '-[rel:'+ options.relationship.type + ' {relData}]-';
          if(options.relationship.direction === 'from') cypher += '>';
          cypher += 'relNode';
          params.relData = options.relationship.data || {};

          //return the relationship information
          returnCypher += ', type(rel), rel';

        }

        // convert the statement into the correct format
        var statement = {
          statement : cypher + returnCypher,
          parameters: params
        };

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
              return cb(null, node);
            }
          });
        }
      });
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
  if(!node.id || !node.node){
    return callback(new Node2NeoError('You must supply a node with an id and model. See findByIdAndUpdate or findOneAndUpdate'));
  }
  var self = this;


  for(var key in updates){
    node.node[key] = updates[key];
  }


  self.schema.validate(node.node, function(err, model){
    if(err) return callback(err);
    // set the initial params
    var params = {
      nodeId: node.id
    };

    // prepare the params for the updates and create the setQUeyr syntax
    var setQuery = '';
    var removeProperties = ' REMOVE';
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
      // tidy up remove properties
      if(removeProperties === ' REMOVE') removeProperties = '';
      else removeProperties = removeProperties.slice(0, -2);
    }

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
  });
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
    nodeId: id
  };

  var query = 'START n = node({nodeId}) ';
  if(options.force) query += 'MATCH n-[r?]-() DELETE r,n';
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
      if(err) return callback(err);
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
 *   fromType: model type. Only required if id entered in from
 *   to: model or id
 *   toType: model type. Only required if id entered in from
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
          id: response[0].data[0].row[0],
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
        id: response.results[0].data[0].row[0],
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